# IoT 绑定与数据更新详解

本文档深入说明 IoT 绑定的创建、更新、删除、查询，以及校验逻辑和数据更新流程。

---

## 一、接口总览

| 操作 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 获取实例所有绑定 | GET | `/scenes/{scene_id}/instances/{instance_id}/iot-bindings` | 返回该实例的绑定列表 |
| 获取单个绑定 | GET | `/scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}` | 按 binding_id 查 |
| 创建绑定 | POST | `/scenes/{scene_id}/instances/{instance_id}/iot-bindings` | 请求体 IoTBindingCreate |
| 更新绑定 | PUT | `/scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}` | 请求体 IoTBindingUpdate（全可选） |
| 删除绑定 | DELETE | `/scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}` | 无请求体 |

**文件**：`app/routers/iot_bindings.py`  
**前置条件**：需登录（`get_current_active_user`），且场景必须属于当前用户（`scene.owner == current_user.id`）。

---

## 二、创建绑定（逐行逻辑）

**接口**：`POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings`

### 1. 权限与归属校验

```python
# 验证场景所有权（必须是自己拥有的场景）
scene = Scene.nodes.get_or_none(uid=scene_id, owner=str(current_user.id))
if not scene:
    raise HTTPException(404, "场景不存在或无访问权限")

# 获取实例
instance = Instance.nodes.get_or_none(uid=instance_id)
if not instance:
    raise HTTPException(404, "实例不存在")

# 验证实例属于该场景（在场景的实例树中）
if not scene.root.single() or not _is_instance_in_scene(instance, scene.root.single()):
    raise HTTPException(404, "实例不属于该场景")
```

- **场景**：按 `scene_id` + `owner=当前用户` 查，保证只能在自己的场景下操作。
- **实例**：必须存在，且通过 `_is_instance_in_scene(instance, root)` 确认在场景的实例树下（根或根的任意子节点）。

### 2. 生成 ID 与构建绑定对象

```python
binding_id = str(uuid4())
binding = IoTBinding(
    id=binding_id,
    **binding_data.model_dump(exclude_unset=True)
)
```

- 绑定 `id` 由后端生成（UUID），请求体里不需要传。
- 用 `IoTBindingCreate` 转成 `IoTBinding`，只传请求里有的字段（`exclude_unset=True`）。

### 3. 配置校验与冲突检查

```python
_validate_binding_config(binding)       # 格式、必填项、范围等
_validate_binding_conflicts(binding, instance.iot_binds or [])  # 目标属性不重复
```

- **配置校验**：见下文「校验逻辑」。
- **冲突检查**：同一实例下，不同绑定的 `bindings[].target` 不能重复（一个实例属性只能被一个绑定的一个映射占用）。

### 4. 写入 Neo4j

```python
current_bindings = instance.iot_binds or []
current_bindings.append(binding.model_dump())
instance.iot_binds = current_bindings
instance.save()
```

- 绑定列表存在 **Instance.iot_binds**（Neo4j 的 JSONProperty）。
- 每次创建是 **append** 一条，再整体写回并 `instance.save()`。

---

## 三、更新绑定（逐行逻辑）

**接口**：`PUT /scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}`

### 1. 权限与归属

与创建相同：校验场景所有权、实例存在、实例属于该场景。

### 2. 查找要更新的绑定

```python
current_bindings = instance.iot_binds or []
binding_index = -1
current_binding = None

for i, binding_data in enumerate(current_bindings):
    if binding_data.get("id") == binding_id:
        binding_index = i
        current_binding = IoTBinding(**binding_data)
        break

if binding_index == -1:
    raise HTTPException(404, "IoT绑定不存在")
```

- 在 `instance.iot_binds` 里按 `id == binding_id` 找到对应项。
- 找不到则 404。

### 3. 合并更新数据

```python
update_data = binding_update.model_dump(exclude_unset=True)  # 只取请求里传的字段
updated_binding_data = current_binding.model_dump()
updated_binding_data.update(update_data)
updated_binding = IoTBinding(**updated_binding_data)
```

- **部分更新**：只更新请求体里出现的字段，未传字段保持原值。
- 先转成 dict，再 update，再反序列化成 `IoTBinding` 做校验。

### 4. 校验与冲突（排除自身）

```python
_validate_binding_config(updated_binding)
_validate_binding_conflicts(updated_binding, current_bindings, exclude_binding_id=binding_id)
```

- 更新后的配置必须合法。
- 冲突检查时排除当前这条绑定，避免自己和自己冲突。

### 5. 写回 Neo4j

```python
current_bindings[binding_index] = updated_binding.model_dump()
instance.iot_binds = current_bindings
instance.save()
```

- 原地替换列表中的这一项，再整体保存。

---

## 四、删除绑定

**接口**：`DELETE /scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}`

逻辑：权限与归属校验同创建 → 在 `instance.iot_binds` 里按 `id == binding_id` 找到下标 → `current_bindings.pop(binding_index)` → 写回 `instance.iot_binds` 并 `instance.save()`。  
返回被删除的绑定信息。

---

## 五、查询绑定

### 1. 获取实例下所有绑定

**GET** `/scenes/{scene_id}/instances/{instance_id}/iot-bindings`

- 校验场景所有权、实例存在、实例属于场景。
- 从 `instance.iot_binds` 逐个用 `IoTBinding(**binding_data)` 解析，无效的跳过并打日志，返回有效列表。

### 2. 获取单个绑定

**GET** `/scenes/{scene_id}/instances/{instance_id}/iot-bindings/{binding_id}`

- 同样校验后，在 `instance.iot_binds` 里找 `id == binding_id`，找到则解析并返回，找不到 404。

---

## 六、校验逻辑

### 1. `_validate_binding_config(binding)`（app/routers/iot_bindings.py 约 937 行）

| 校验项 | 规则 |
|--------|------|
| id | 非空 |
| sourceId | 非空 |
| HTTP 协议 | 必须带 `httpConfig`；timeout > 0；若有 pollInterval 则 > 0 |
| bindings | 每项为 dict，且包含 `source`、`target`；同一绑定内 `target` 不重复 |
| valueMapping | 若存在：inputMin < inputMax，outputMin < outputMax |
| interpolation | 若存在：duration > 0 |
| conditions | 若存在：每项需含 field、operator、value（具体见模型） |

### 2. `_validate_binding_conflicts(binding, existing_bindings, exclude_binding_id=None)`（约 906 行）

- 取出当前 `binding.bindings` 里所有 `target` 路径。
- 遍历同一实例下其它绑定（`existing_bindings`），若 `exclude_binding_id` 指定则跳过该 id。
- 若其它绑定中已有相同 `target`，则抛出 `ValueError`，提示该目标属性已被某绑定使用。

含义：**同一实例上，一个实例属性路径（如 `instance.transform.location.y`）只能被一个绑定的一个映射使用**，避免多个绑定写同一属性导致行为混乱。

---

## 七、实例是否属于场景：`_is_instance_in_scene`

```python
def _is_instance_in_scene(instance: Instance, root_instance: Instance) -> bool:
    if instance.uid == root_instance.uid:
        return True
    for child in root_instance.children:
        if _is_instance_in_scene(instance, child):
            return True
    return False
```

- 若 `instance` 就是场景根节点，返回 True。
- 否则递归检查根的所有子节点；若在某棵子树里找到该实例则返回 True。
- 用于保证「只能在该场景的实例树上」为实例创建/更新/删除绑定。

---

## 八、数据更新流程（绑定之后如何“更新”）

绑定配置本身只存在 Neo4j 的 `Instance.iot_binds` 里，**不会自动拉取或写入 IoT 数据**。数据更新是「前端驱动」的：

1. **前端拉取绑定与连接信息**
   - `GET .../iot-bindings` 得到该实例的绑定列表。
   - 每个绑定的 `sourceId` 对应一条连接配置（MQTT/WebSocket/HTTP），通过 `GET /iot-connections/{sourceId}`（或项目里等价接口）拿到连接参数。

2. **前端连接数据源**
   - 根据 `protocol` 和连接配置建立 MQTT 订阅 / WebSocket 连接 / HTTP 轮询。

3. **前端收到数据后做映射与写回**
   - 按绑定的 `bindings[].source` 从报文里取字段，按 `bindings[].target` 知道要写实例的哪个属性。
   - 可选：valueMapping、interpolation、transform、conditions/triggerResults 在前端或中间层实现。
   - 写回方式：调用 **`PUT /instances/{instance_id}`**，在请求体里带 `transform`、`properties` 等，完成「IoT 数据 → 实例属性」的更新。

因此：**IoT 数据更新 = 绑定配置（存在 Neo4j）+ 连接配置（存在 MongoDB）+ 前端连接与逻辑 + 更新实例接口（PUT /instances/{instance_id}）**。

---

## 九、绑定配置与实例属性的对应关系

- **bindings[].target** 常用形式：
  - `instance.transform.location.x/y/z`
  - `instance.transform.rotation.x/y/z`
  - `instance.transform.scale.x/y/z`
  - `instance.properties.xxx`（自定义属性）
- 前端或中间层解析 target 后，拼成 `PUT /instances/{instance_id}` 的 body，例如：
  - 只更新位置：`{"transform": {"location": [x, y, z], "rotation": [...], "scale": [...]}}`
  - 只更新属性：`{"properties": {"temperature": 25}}`

---

## 十、小结

- **创建**：校验场景归属与实例归属 → 生成 binding id → 配置校验 + 目标冲突检查 → append 到 `instance.iot_binds` 并 save。
- **更新**：同样校验 → 按 binding_id 找到项 → 部分合并 → 再次校验与冲突（排除自身）→ 替换列表中该项并 save。
- **删除**：校验 → 按 binding_id 找到并 pop → save。
- **查询**：校验后直接读 `instance.iot_binds`，解析为 `IoTBinding` 列表或单条返回。
- **校验**：配置合法（必填、范围、HTTP 等）+ 同实例下目标属性不重复。
- **数据更新**：由前端根据绑定与连接配置连接数据源，收到数据后通过 **PUT /instances/{instance_id}** 更新实例属性，完成 IoT 数据绑定与更新闭环。
