# 场景与实例创建及 Neo4j 存储说明

本文档说明「创建场景」「创建实例」的接口、数据流，以及二者在 Neo4j 中的存储关系（Scene / Instance 节点，ROOT / HAS_INSTANCE / PARENT_OF 关系）。

---

## 一、整体关系概览

- **创建场景**：产生 **Scene** 节点 + **根 Instance** 节点 + **Scene -[:ROOT]-> 根 Instance**。
- **创建实例**：在已有场景下产生 **Instance** 节点，并建立 **父 -[:PARENT_OF]-> 新实例**、**Scene -[:HAS_INSTANCE]-> 新实例**。
- **Neo4j 中的结构**：
  - **节点**：Scene（场景）、Instance（实例，含根实例与业务实例）。
  - **关系**：ROOT（场景→根实例）、PARENT_OF（实例树父子）、HAS_INSTANCE（场景→实例，表示场景包含该实例）。

| 关系类型       | 方向                    | 何时建立           |
|----------------|-------------------------|--------------------|
| **ROOT**       | Scene → 根 Instance     | 创建场景时 scene.save() |
| **PARENT_OF**  | 父 Instance → 子 Instance | 创建实例时 parent/root.children.connect(inst) |
| **HAS_INSTANCE** | Scene → Instance     | 创建实例时 inst.scenes.connect(scene) |

---

## 二、创建场景

### 2.1 流程概览

1. 前端调用 **POST /scenes**，请求体为场景名称等（SceneCreate）。
2. 后端 **create_scene** 创建 Scene 对象，设置 name、owner、origin 等，调用 **scene.save()**。
3. **Scene.save()** 先保存 Scene 节点（生成 sceneId），若无根节点则创建根 Instance 并建立 **Scene -[:ROOT]-> 根 Instance** 关系。
4. 返回 **scene.uid**（sceneId）给前端。

### 2.2 接口与路由

**路径**：POST `/scenes`  
**文件**：`app/routers/scene.py`（约 21–36 行）

| 项目       | 说明 |
|------------|------|
| 请求体模型 | **SceneCreate**（name 必填，origin、chart_binds、tiles_binding 可选） |
| 依赖       | `get_current_active_user`（需登录） |
| 返回值     | `{"uid": scene.uid, "name": scene.name, "owner": scene.owner, "origin": ..., "chart_binds": ..., "tiles_binding": ...}` |

### 2.3 路由内逻辑

```python
scene = Scene(name=data.name, owner=str(current_user.id))
if data.origin:
    scene.origin = data.origin
else:
    scene.origin = {"longitude": 113, "latitude": 23, "height": 50}
if data.chart_binds:
    scene.chart_binds = data.chart_binds
if data.tiles_binding:
    scene.tiles_binding = data.tiles_binding
scene.save()
return {"uid": scene.uid, "name": scene.name, ...}
```

- **scene.uid**：在 **scene.save()** 时由 neomodel 的 **UniqueIdProperty** 自动生成，即 **sceneId**。

### 2.4 Scene.save()（创建根实例与 ROOT 关系）

**文件**：`app/models/scene.py`（约 80–87 行）

```python
def save(self):
    super().save()   # 将 Scene 节点写入 Neo4j，生成 Scene.uid
    if not self.root:
        root_instance = Instance(name=f"Root of {self.name}").save()
        self.root.connect(root_instance)   # Scene -[:ROOT]-> 根 Instance
    return self
```

| 步骤 | 作用 |
|------|------|
| super().save() | Scene 节点写入 Neo4j，生成 **Scene.uid**（sceneId） |
| Instance(...).save() | 创建根 Instance 节点并写入 Neo4j，生成 **根 Instance.uid** |
| self.root.connect(root_instance) | 建立 **Scene -[:ROOT]-> 根 Instance** 关系 |

---

## 三、创建实例

### 3.1 流程概览

1. 前端调用 **POST /scenes/{scene_id}/instances**，传入场景 ID、实例名称、父节点 uid（可选）及资产/变换/绑定等。
2. 后端校验场景存在；若传了 `parent_uid` 则校验父节点存在。
3. 用 **InstanceCreate** 构建 **Instance**，设置 name、asset_id、transform、properties 等，**inst.save()** 写入 Neo4j（生成实例 uid）。
4. 建立父子关系：有父则 **parent.children.connect(inst)**；无父则 **root.children.connect(inst)**（根 -[:PARENT_OF]-> 新实例）。
5. **inst.scenes.connect(scene)**，建立 **Scene -[:HAS_INSTANCE]-> Instance**。
6. 返回新实例的 **uid**、**name**。

### 3.2 接口与路由

**路径**：POST `/scenes/{scene_id}/instances`  
**文件**：`app/routers/scene.py`（约 176–220 行）

| 项目       | 说明 |
|------------|------|
| 路径参数   | **scene_id**：场景 uid（sceneId） |
| 请求体     | **InstanceCreate**（name、asset_id 必填；parent_uid、transform、properties、materials、iot_binds 等可选） |
| 依赖       | `get_current_active_user`（需登录） |
| 返回值     | `{"uid": inst.uid, "name": inst.name}` |

### 3.3 请求体 InstanceCreate 要点

| 字段        | 类型 | 必填 | 说明 |
|-------------|------|------|------|
| name        | str  | 是   | 实例名称 |
| asset_id    | str  | 是   | 资产 ID |
| asset_type  | str  | 否   | 默认 "model" |
| parent_uid  | str  | 否   | 父实例 uid；不传则挂到场景根节点下 |
| transform   | dict | 否   | location、rotation、scale |
| properties  | dict | 否   | 扩展属性 |
| materials   | list | 否   | 材质覆盖 |
| iot_binds   | list | 否   | IoT 绑定配置 |

### 3.4 路由内逻辑要点

```python
scene = Scene.nodes.get_or_none(uid=scene_id)
if not scene:
    raise HTTPException(404, "场景不存在")

parent = None
if data.parent_uid:
    parent = Instance.nodes.get_or_none(uid=data.parent_uid)
    if not parent:
        raise HTTPException(404, "父节点不存在")

inst = Instance(name=data.name)
# 设置 asset_id, asset_type, transform, properties, materials, iot_binds 等
inst.save()

if parent:
    parent.children.connect(inst)   # 父 -[:PARENT_OF]-> 新实例
else:
    root = scene.root.single()
    if root:
        root.children.connect(inst) # 根 -[:PARENT_OF]-> 新实例

inst.scenes.connect(scene)         # Scene -[:HAS_INSTANCE]-> Instance
return {"uid": inst.uid, "name": inst.name}
```

- **inst.uid**：在 **inst.save()** 时由 **UniqueIdProperty** 自动生成并写入 Neo4j。

---

## 四、Neo4j 存储关系总览

### 4.1 节点

| 节点标签   | 含义     | 何时创建           | 主要属性示例 |
|------------|----------|--------------------|--------------|
| **Scene**  | 场景     | POST /scenes       | uid, name, owner, origin, chart_binds, tiles_binding |
| **Instance** | 实例（含根） | 创建场景时生成根；创建实例时生成业务实例 | uid, name, asset_id, transform, properties, materials, iot_binds |

### 4.2 关系

| 关系类型        | 方向                         | 含义                     | 何时建立     |
|-----------------|------------------------------|--------------------------|--------------|
| **ROOT**        | Scene → Instance（根）       | 场景拥有唯一根实例       | scene.save() |
| **PARENT_OF**   | Instance → Instance          | 实例树父子               | 创建实例时 parent/root.children.connect(inst) |
| **HAS_INSTANCE**| Scene → Instance             | 场景包含该实例           | 创建实例时 inst.scenes.connect(scene) |

### 4.3 结构示意

```
(Scene) -[:ROOT]-> (根 Instance)
    |                    |
    |                    + -[:PARENT_OF]-> (实例 A) -[:PARENT_OF]-> (实例 A1)
    |                    + -[:PARENT_OF]-> (实例 B)
    |
    + -[:HAS_INSTANCE]-> (根 Instance)
    + -[:HAS_INSTANCE]-> (实例 A)
    + -[:HAS_INSTANCE]-> (实例 A1)
    + -[:HAS_INSTANCE]-> (实例 B)
```

- 根实例既被 ROOT 指向，也可通过 HAS_INSTANCE 归属场景；业务实例通过 PARENT_OF 挂在根或其子节点下，并通过 HAS_INSTANCE 归属到场景。

---

## 五、Scene / Instance 模型要点

### 5.1 Scene（app/models/scene.py）

| 属性/关系     | 说明 |
|---------------|------|
| uid           | UniqueIdProperty，场景唯一标识（sceneId） |
| name, owner   | 场景名称、创建者 ID |
| origin        | JSON，场景原点（经纬度、高程） |
| chart_binds   | JSON，绑定的图表 ID 列表 |
| tiles_binding | JSON，WMTS 底图绑定 |
| root          | RelationshipTo('Instance', 'ROOT', cardinality=One)，场景 → 根 Instance |

### 5.2 Instance（app/models/scene.py）

| 属性/关系   | 说明 |
|-------------|------|
| uid         | UniqueIdProperty，实例唯一标识 |
| name        | 实例名称 |
| asset_id    | 资产 ID |
| asset_type  | 默认 "model" |
| transform   | JSON，location / rotation / scale |
| properties  | JSON，扩展属性 |
| materials   | JSON，材质列表 |
| iot_binds   | JSON，IoT 绑定配置 |
| parent      | RelationshipFrom('Instance', 'PARENT_OF')，谁是我父节点 |
| children    | RelationshipTo('Instance', 'PARENT_OF')，我的子节点 |
| scenes      | RelationshipFrom(Scene, 'HAS_INSTANCE')，我属于哪些场景 |

---

## 六、数据保存位置

| 内容 | 存储位置 |
|------|----------|
| Scene 节点 | **Neo4j**，标签 Scene |
| Instance 节点（根 + 业务实例） | **Neo4j**，标签 Instance |
| ROOT / PARENT_OF / HAS_INSTANCE | **Neo4j**，关系类型 |
| properties 若引用 Mongo 文档 | 文档在 **MongoDB**；Neo4j 的 Instance.properties 可能存其 _id |

---

## 七、相关文件

| 说明 | 文件路径 |
|------|----------|
| 创建场景接口 | app/routers/scene.py（create_scene） |
| 创建实例接口 | app/routers/scene.py（create_instance） |
| Scene / Instance 模型、SceneCreate、InstanceCreate | app/models/scene.py |

---

## 八、小结

- **创建场景**：POST /scenes → create_scene → scene.save() → 写入 Scene 节点 + 根 Instance 节点 + **Scene -[:ROOT]-> 根 Instance**，返回 scene.uid。
- **创建实例**：POST /scenes/{scene_id}/instances → 校验场景与父节点 → inst.save() 写入 Instance 节点 → parent/root.children.connect(inst) 建立 **PARENT_OF** → inst.scenes.connect(scene) 建立 **HAS_INSTANCE**，返回 inst.uid。
- **Neo4j 存储**：场景与实例的节点及 ROOT、PARENT_OF、HAS_INSTANCE 关系均在 Neo4j 中维护；实例的 transform、properties、iot_binds 等为 Instance 节点上的 JSON 属性，后续 IoT 实时值写回时通过 PUT /instances/{id} 更新这些属性。
