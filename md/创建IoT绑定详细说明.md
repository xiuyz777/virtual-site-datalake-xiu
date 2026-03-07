# 创建 IoT 绑定详细说明

## 概述

创建 IoT 绑定是将外部 IoT 数据源（MQTT/HTTP/WebSocket）与 3D 场景中的实例属性、模型节点或材质属性建立映射关系的过程。本文档详细说明从前端表单提交到后端存储的完整流程。

## 功能入口

### 前端入口

**组件**：`IoTBindingConfigModal`

**位置**：`web/src/components/IoTBindingConfigModal.tsx`

**触发方式**：用户完成所有配置步骤后，点击「创建绑定」按钮

## 完整流程

### 一、前端表单数据收集

#### 1.1 表单结构

IoT 绑定配置采用**分步骤表单**，包含以下步骤：

1. **步骤 0：选择数据源**
   - 协议类型（`protocol`）：MQTT / HTTP / WebSocket
   - 数据类型（`dataType`）：JSON / TEXT / NUMBER / BOOLEAN 等
   - 连接配置（`sourceId`）：已创建的 IoT 连接配置 ID

2. **步骤 1：配置绑定映射**
   - 绑定映射列表（`bindings`）：`[{source, target, direction}]`
   - 每个映射包含：
     - `source`：数据源路径（通过「预览数据」选择）
     - `target`：目标属性路径（通过「选择属性」选择）
     - `direction`：绑定方向（IoT -> Instance / Instance -> IoT / 双向）

3. **步骤 2：高级选项**（可选）
   - 绑定名称（`name`）
   - 是否启用（`enabled`）
   - 数值映射（`valueMapping`）
   - 插值配置（`interpolation`）
   - 更新间隔（`updateInterval`）
   - 数据转换脚本（`transform`）

4. **步骤 3：验证配置**（可选）
   - 前端验证
   - 后端验证
   - 测试绑定

#### 1.2 数据收集函数

**函数**：`handleSave()` (第 773-859 行)

**代码位置**：`web/src/components/IoTBindingConfigModal.tsx`

**实现逻辑**：
```typescript
const handleSave = async () => {
  try {
    setLoading(true);
    
    // 手动构造表单数据（因为分步骤表单无法通过 getFieldsValue() 正确获取所有字段）
    const values = {
      protocol: form.getFieldValue('protocol'),
      dataType: form.getFieldValue('dataType'),
      sourceId: form.getFieldValue('sourceId'),
      bindings: form.getFieldValue('bindings') || [],
      enabled: form.getFieldValue('enabled') !== undefined ? form.getFieldValue('enabled') : true,
      name: form.getFieldValue('name'),
      valueMapping: form.getFieldValue('valueMapping'),
      interpolation: form.getFieldValue('interpolation'),
      updateInterval: form.getFieldValue('updateInterval'),
      transform: form.getFieldValue('transform')
    };
    
    // 验证必填字段
    const missingFields = [];
    if (!values.protocol) missingFields.push('协议类型');
    if (!values.dataType) missingFields.push('数据类型');
    if (!values.sourceId) missingFields.push('连接配置');
    
    if (missingFields.length > 0) {
      message.error(`请完成以下必填项：${missingFields.join('、')}`);
      setCurrentStep(0);
      return;
    }
    
    if (!values.bindings || values.bindings.length === 0) {
      message.error('请至少添加一个绑定映射');
      setCurrentStep(1);
      return;
    }
    
    // 修复数据结构：确保符合后端期望
    const fixedBinding: IoTBinding = {
      id: editingBinding?.id || `binding_${Date.now()}`,
      name: values.name || undefined,
      enabled: values.enabled !== undefined ? values.enabled : true,
      protocol: values.protocol,
      dataType: values.dataType,
      sourceId: values.sourceId,
      bindings: validateBindings(values.bindings || [], true),
      valueMapping: values.valueMapping || undefined,
      interpolation: values.interpolation || undefined,
      updateInterval: values.updateInterval || undefined,
      transform: values.transform || undefined
    };
    
    // 调用 API 创建绑定
    if (editingBinding) {
      await iotBindingAPI.updateInstanceBinding(sceneId, instanceId, editingBinding.id, fixedBinding);
      message.success('IoT绑定更新成功');
    } else {
      await iotBindingAPI.createInstanceBinding(sceneId, instanceId, fixedBinding);
      message.success('IoT绑定创建成功');
    }
    
    // 调用父组件的保存回调
    onSave(fixedBinding);
    
    // 关闭模态框
    onClose();
  } catch (error) {
    console.error('保存绑定失败:', error);
    message.error('保存绑定失败');
  } finally {
    setLoading(false);
  }
};
```

#### 1.3 数据验证

**前端验证**：
- 必填字段检查：`protocol`、`dataType`、`sourceId`
- 绑定映射检查：至少包含一个 `bindings` 项
- 字段格式验证：通过 `validateBindings()` 函数验证绑定映射格式

**validateBindings 函数**：
```typescript
const validateBindings = (bindings: any[], strict: boolean = false) => {
  return bindings.map((binding, index) => {
    if (!binding.source || !binding.target) {
      if (strict) {
        throw new Error(`绑定映射 ${index + 1} 缺少 source 或 target 字段`);
      }
      return null;
    }
    return {
      source: binding.source,
      target: binding.target,
      direction: binding.direction || BindingDirection.IOT_TO_INSTANCE
    };
  }).filter(Boolean);
};
```

### 二、API 调用

#### 2.1 前端 API 调用

**函数**：`createInstanceBinding()`

**代码位置**：`web/src/services/iotBindingApi.ts` (第 229 行)

**实现**：
```typescript
createInstanceBinding: (sceneId: string, instanceId: string, data: IoTBindingCreate) =>
  api.post<IoTBinding>(`/scenes/${sceneId}/instances/${instanceId}/iot-bindings`, data),
```

**请求格式**：
```typescript
POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings
Content-Type: application/json

{
  "name": "温度传感器绑定",
  "enabled": true,
  "protocol": "mqtt",
  "dataType": "json",
  "sourceId": "mqtt_connection_id_123",
  "bindings": [
    {
      "source": "sensor/temperature.data.value",
      "target": "instance.instance.properties.temperature",
      "direction": 0
    }
  ],
  "valueMapping": {
    "inputMin": 0,
    "inputMax": 100,
    "outputMin": -50,
    "outputMax": 50,
    "clamp": true
  },
  "interpolation": {
    "type": "linear",
    "duration": 1000,
    "easing": "ease-in-out"
  },
  "updateInterval": 1000
}
```

### 三、后端处理流程

#### 3.1 API 端点

**端点**：`POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings`

**代码位置**：`app/routers/iot_bindings.py` (第 189-246 行)

**函数签名**：
```python
@router.post("/scenes/{scene_id}/instances/{instance_id}/iot-bindings", response_model=IoTBinding)
async def create_instance_iot_binding(
    scene_id: str,
    instance_id: str,
    binding_data: IoTBindingCreate,
    current_user: UserInDB = Depends(get_current_active_user)
):
```

#### 3.2 后端处理步骤

**步骤 1：验证场景所有权**

```python
# 验证场景是否存在且属于当前用户
scene = Scene.nodes.get_or_none(uid=scene_id, owner=str(current_user.id))
if not scene:
    raise HTTPException(status_code=404, detail="场景不存在或无访问权限")
```

**步骤 2：获取实例**

```python
# 获取实例节点
instance = Instance.nodes.get_or_none(uid=instance_id)
if not instance:
    raise HTTPException(status_code=404, detail="实例不存在")
```

**步骤 3：验证实例属于场景**

```python
# 验证实例是否属于该场景（递归检查）
if not scene.root.single() or not _is_instance_in_scene(instance, scene.root.single()):
    raise HTTPException(status_code=404, detail="实例不属于该场景")
```

**辅助函数**：`_is_instance_in_scene()` (第 894-904 行)
```python
def _is_instance_in_scene(instance: Instance, root_instance: Instance) -> bool:
    """检查实例是否属于场景"""
    if instance.uid == root_instance.uid:
        return True
    
    # 递归检查子实例
    for child in root_instance.children:
        if _is_instance_in_scene(instance, child):
            return True
    
    return False
```

**步骤 4：创建绑定对象**

```python
# 创建新的绑定ID
binding_id = str(uuid4())

# 创建绑定对象
binding = IoTBinding(
    id=binding_id,
    **binding_data.model_dump(exclude_unset=True)
)
```

**步骤 5：验证绑定配置**

```python
# 验证绑定配置
_validate_binding_config(binding)
```

**验证函数**：`_validate_binding_config()` (第 937-1003 行)

**验证内容**：
1. **基本字段验证**：
   - `id` 不能为空
   - `sourceId` 不能为空

2. **协议特定配置验证**：
   - HTTP 协议必须配置 `httpConfig`
   - HTTP 超时时间必须大于 0
   - HTTP 轮询间隔必须大于 0（如果配置）

3. **绑定映射验证**：
   - 每个绑定映射必须是字典格式
   - 必须包含 `source` 和 `target` 字段
   - 当前绑定内部不能有重复的目标属性

4. **数值映射验证**：
   - `inputMin < inputMax`
   - `outputMin < outputMax`

5. **插值配置验证**：
   - `duration` 必须大于 0

6. **条件配置验证**：
   - 条件字段路径不能为空
   - 操作符必须有效

7. **节点绑定验证**：
   - 节点名称不能为空
   - 绑定类型必须有效

**步骤 6：检查绑定冲突**

```python
# 检查与已有绑定的冲突
current_bindings = instance.iot_binds or []
_validate_binding_conflicts(binding, current_bindings)
```

**验证函数**：`_validate_binding_conflicts()` (第 906-935 行)

**验证逻辑**：
- 提取当前绑定的所有目标属性路径
- 遍历已有绑定，检查是否有相同的目标属性路径
- 如果存在冲突，抛出错误：`目标属性 '{path}' 已被 {binding_name} 使用，不能重复绑定`

**步骤 7：保存绑定到 Neo4j**
```python
# 更新实例的绑定列表
current_bindings = instance.iot_binds or []
current_bindings.append(binding.model_dump())
instance.iot_binds = current_bindings
instance.save()
点击「创建绑定」→ handleSave 手动收集所有步骤的字段 → 做前端必填校验 → 用 validateBindings 修正/过滤 bindings → 组装成 fixedBinding → 调 createInstanceBinding(sceneId, instanceId, fixedBinding) 接口 → 后端验证 _validate_binding_config + _validate_binding_conflicts 后，把这条绑定 JSON 追加到该实例的 iot_binds（Neo4j）里 → 前端 onSave 刷新列表并关闭弹窗。
最终这条绑定数据是存在 Neo4j 里的实例节点上。
存储位置：Instance 模型的 iot_binds 字段（app/models/scene.py 里是 iot_binds = JSONProperty(default=list)）。
写入流程（以创建为例）：
接口 POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings 找到对应的 Instance（按 uid == instance_id）。
通过 _validate_binding_config 和 _validate_binding_conflicts 校验。
然后：
    current_bindings = instance.iot_binds or []    current_bindings.append(binding.model_dump())    instance.iot_binds = current_bindings    instance.save()
也就是：在该实例节点的 iot_binds JSON 数组里追加一条绑定配置，并 save() 回 Neo4j。

**存储位置**：
- **数据库**：Neo4j
- **节点**：`Instance` 节点
- **字段**：`iot_binds` (JSONProperty)
- **格式**：JSON 数组，每个元素是一个绑定配置对象

**步骤 8：返回结果**

```python
logger.info(f"创建IoT绑定成功: binding_id={binding_id}")
return binding
```

### 四、数据存储结构

#### 4.1 Instance 模型定义

**代码位置**：`app/models/scene.py` (第 88-115 行)

```python
class Instance(StructuredNode):
    # ...
    iot_binds = JSONProperty(default=list)  # IoTBinding对象数组
```

#### 4.2 存储格式

**Neo4j 存储格式**：
```json
{
  "iot_binds": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "温度传感器绑定",
      "enabled": true,
      "protocol": "mqtt",
      "dataType": "json",
      "sourceId": "mqtt_connection_id_123",
      "bindings": [
        {
          "source": "sensor/temperature.data.value",
          "target": "instance.instance.properties.temperature",
          "direction": 0
        }
      ],
      "valueMapping": {
        "inputMin": 0,
        "inputMax": 100,
        "outputMin": -50,
        "outputMax": 50,
        "clamp": true
      },
      "interpolation": {
        "type": "linear",
        "duration": 1000,
        "easing": "ease-in-out"
      },
      "updateInterval": 1000
    }
  ]
}
```

### 五、数据验证详细说明

#### 5.1 绑定映射格式验证

**source 路径格式规则**：

| 协议类型 | 数据类型 | source 格式 | 示例 |
|---------|---------|------------|------|
| MQTT | JSON | `{订阅路径}.{json对象key层级}` | `sensor/temperature.data.value` |
| MQTT | 其他 | `{订阅路径}` | `sensor/temperature` |
| WebSocket/HTTP | JSON | `{json对象key层级}` | `data.value` |
| WebSocket/HTTP | 其他 | 空字符串 | `""` |

**target 路径格式规则**：

| 目标类型 | 格式 | 示例 |
|---------|------|------|
| 实例属性 | `instance.{property}.{key}` | `instance.instance.properties.temperature` |
| 模型节点 | `node.{nodeId}.{property}` | `node.1.translation` |
| 材质属性 | `material.{materialId}.{property}` | `material.0.baseColorFactor` |

#### 5.2 冲突检测规则

**规则**：同一个实例的不同绑定不能映射到相同的目标属性路径

**示例**：
```python
# 绑定1
{
  "bindings": [
    {"source": "sensor1.temp", "target": "instance.instance.properties.temperature"}
  ]
}

# 绑定2（冲突）
{
  "bindings": [
    {"source": "sensor2.temp", "target": "instance.instance.properties.temperature"}  # ❌ 冲突
  ]
}
```

**错误信息**：
```
目标属性 'instance.instance.properties.temperature' 已被 绑定1 使用，不能重复绑定
```

### 六、错误处理

#### 6.1 前端错误处理

**验证失败**：
- 必填字段缺失：显示错误提示，跳转到对应步骤
- 绑定映射为空：显示错误提示，跳转到步骤 1

**API 调用失败**：
```typescript
catch (error) {
  console.error('保存绑定失败:', error);
  
  // 更详细的错误信息
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as any;
    console.error('💾 保存错误响应:', axiosError.response?.data);
    console.error('💾 保存错误状态:', axiosError.response?.status);
  }
  
  message.error('保存绑定失败');
}
```

#### 6.2 后端错误处理

**HTTP 异常**：
- `404`：场景不存在、实例不存在、实例不属于场景
- `400`：绑定配置无效、绑定冲突
- `500`：内部服务器错误

**验证异常**：
```python
except Exception as e:
    logger.error(f"绑定配置验证失败: {e}")
    raise HTTPException(status_code=400, detail=f"绑定配置无效: {str(e)}")
```

### 七、关键代码位置

#### 前端

1. **`web/src/components/IoTBindingConfigModal.tsx`**
   - `handleSave()` 函数（第 773-859 行）：保存绑定逻辑
   - `handleValidate()` 函数（第 596-702 行）：验证绑定配置
   - `handleTest()` 函数（第 705-771 行）：测试绑定
   - `validateBindings()` 函数：验证绑定映射格式

2. **`web/src/services/iotBindingApi.ts`**
   - `createInstanceBinding()` API（第 229 行）
   - `IoTBinding`、`IoTBindingCreate` 接口定义

#### 后端

1. **`app/routers/iot_bindings.py`**
   - `create_instance_iot_binding()` 函数（第 189-246 行）
   - `_validate_binding_config()` 函数（第 937-1003 行）
   - `_validate_binding_conflicts()` 函数（第 906-935 行）
   - `_is_instance_in_scene()` 函数（第 894-904 行）

2. **`app/models/iot_bindings.py`**
   - `IoTBinding` 模型定义（第 101-164 行）
   - `IoTBindingCreate` 模型定义（第 169-192 行）

3. **`app/models/scene.py`**
   - `Instance` 模型定义（第 88-115 行）
   - `iot_binds` 字段定义（第 106 行）

### 八、完整流程图

```
用户点击「创建绑定」按钮
  ↓
前端 handleSave() 函数
  ↓
1. 收集表单数据（分步骤表单）
  ↓
2. 前端验证：
   - 必填字段检查
   - 绑定映射格式验证
  ↓
3. 构造绑定对象（fixedBinding）
  ↓
4. 调用 API：POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings
  ↓
后端 create_instance_iot_binding() 函数
  ↓
5. 验证场景所有权
  ↓
6. 获取实例节点
  ↓
7. 验证实例属于场景（递归检查）
  ↓
8. 创建绑定对象（生成 UUID）
  ↓
9. 验证绑定配置：
   - 基本字段验证
   - 协议特定配置验证
   - 绑定映射验证
   - 数值映射验证
   - 插值配置验证
   - 条件配置验证
   - 节点绑定验证
  ↓
10. 检查绑定冲突：
    - 提取目标属性路径
    - 与已有绑定比较
    - 如果冲突，抛出错误
  ↓
11. 保存到 Neo4j：
    - 获取当前绑定列表
    - 追加新绑定
    - 更新 instance.iot_binds
    - 调用 instance.save()
  ↓
12. 返回绑定对象
  ↓
前端接收响应
  ↓
13. 显示成功消息
  ↓
14. 调用父组件回调（刷新绑定列表）
  ↓
15. 关闭模态框
```

### 九、注意事项

1. **绑定 ID 生成**：
   - 创建新绑定时，后端自动生成 UUID
   - 更新绑定时，使用原有 ID

2. **数据存储**：
   - 绑定数据存储在 Neo4j 的 `Instance` 节点中
   - `iot_binds` 是 JSONProperty，存储 JSON 数组
   - 每个绑定是数组中的一个元素

3. **冲突检测**：
   - 同一实例的不同绑定不能映射到相同的目标属性路径
   - 但可以映射到不同的目标属性路径
   - 同一绑定的不同映射可以映射到不同的目标属性路径

4. **验证时机**：
   - 前端验证：提交前进行基本验证
   - 后端验证：服务器端进行完整验证
   - 可选验证：步骤 3 提供前端和后端验证功能

5. **错误处理**：
   - 前端显示用户友好的错误消息
   - 后端记录详细的错误日志
   - 验证失败时，前端会跳转到对应的步骤

6. **数据格式**：
   - 绑定映射中的 `direction` 字段：0 = IoT -> Instance, 1 = Instance -> IoT, 2 = 双向
   - `source` 和 `target` 路径使用点号分隔
   - 数值映射使用线性映射算法

## 总结

创建 IoT 绑定是一个多步骤的过程，包括：
1. **前端数据收集**：分步骤表单收集配置信息
2. **前端验证**：基本字段和格式验证
3. **API 调用**：发送绑定配置到后端
4. **后端验证**：场景所有权、实例归属、绑定配置、冲突检测
5. **数据存储**：保存到 Neo4j 的 Instance 节点的 `iot_binds` 字段

整个过程确保了数据的完整性和一致性，防止了配置错误和冲突。
