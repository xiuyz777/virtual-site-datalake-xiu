# IoT数据更新流程说明

本文档详细说明 IoT 数据的更新流程，从绑定创建到数据更新的完整链路。

---

## 一、流程概览

```
1. 创建 IoT 数据源连接（MQTT/WebSocket/HTTP）
   ↓
2. 创建 IoT 绑定（关联实例和数据源）
   ↓
3. 绑定配置存储在 Instance.iot_binds（Neo4j）
   ↓
4. 前端根据绑定配置连接数据源
   ↓
5. 前端接收 IoT 数据并更新实例属性
```

---

## 二、第一步：创建 IoT 数据源连接

### 1. 支持的协议类型

**文件**：`app/models/iot_bindings.py`（约 18-22 行）

```python
class IoTProtocolType(str, Enum):
    """IoT通信协议类型"""
    MQTT = "mqtt"
    WEBSOCKET = "websocket"
    HTTP = "http"
```

### 2. 数据源存储位置

| 协议类型 | MongoDB 集合 | 说明 |
|---------|-------------|------|
| MQTT | `mqtt_connections` | MQTT 连接配置（host, port, username, password 等） |
| WebSocket | `websocket_connections` | WebSocket 连接配置（url, protocols, headers 等） |
| HTTP | `http_connections` | HTTP 连接配置（base_url, auth_type, headers 等） |

### 3. 数据源配置示例

**MQTT 连接配置**：
```json
{
  "_id": "507f1f77bcf86cd799439011",
  "name": "温度传感器MQTT",
  "host": "mqtt.example.com",
  "port": 1883,
  "username": "user",
  "password": "pass",
  "use_tls": false,
  "enabled": true
}
```

**HTTP 连接配置**：
```json
{
  "_id": "507f1f77bcf86cd799439012",
  "name": "API数据源",
  "base_url": "https://api.example.com",
  "auth_type": "bearer",
  "headers": {"Authorization": "Bearer token"},
  "timeout": 30
}
```

---

## 三、第二步：创建 IoT 绑定

### 1. 接口定义

**路径**：`POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings`  
**文件**：`app/routers/iot_bindings.py`（约 188-246 行）

| 项目 | 说明 |
|------|------|
| 路径参数 | **scene_id**：场景 uid<br>**instance_id**：实例 uid |
| 请求体 | **IoTBindingCreate**（见下） |
| 依赖 | `get_current_active_user`（需登录） |
| 返回值 | **IoTBinding**（创建的绑定配置） |

### 2. 请求体模型：IoTBindingCreate

**文件**：`app/models/iot_bindings.py`（约 174-190 行）

```python
class IoTBindingCreate(BaseModel):
    name: Optional[str] = None
    enabled: bool = True
    protocol: IoTProtocolType          # 协议类型：mqtt/websocket/http
    dataType: IoTDataType              # 数据类型：text/json/number/boolean/image_base64 等
    sourceId: str                      # IoT数据源ID（MongoDB文档_id）
    bindings: List[Dict[str, Any]] = []  # 绑定映射关系数组
    nodeBindings: Optional[List[NodeBinding]] = None  # GLTF节点绑定（骨骼动画）
    valueMapping: Optional[ValueMapping] = None  # 数值映射配置
    interpolation: Optional[InterpolationConfig] = None  # 插值配置
    conditions: Optional[List[BindingCondition]] = None  # 触发条件
    triggerResults: Optional[List[TriggerResult]] = None  # 触发结果
    httpConfig: Optional[HTTPConfig] = None  # HTTP协议配置
    updateInterval: Optional[float] = None  # 更新间隔（毫秒）
    transform: Optional[str] = None  # 数据转换脚本（JavaScript）
    metadata: Optional[Dict[str, Any]] = None  # 扩展元数据
```

### 3. 创建绑定的流程（iot_bindings.py 195-246）

```python
# 1. 验证场景所有权
scene = Scene.nodes.get_or_none(uid=scene_id, owner=str(current_user.id))
if not scene:
    raise HTTPException(404, "场景不存在或无访问权限")

# 2. 获取实例并验证属于该场景
instance = Instance.nodes.get_or_none(uid=instance_id)
if not instance:
    raise HTTPException(404, "实例不存在")
if not scene.root.single() or not _is_instance_in_scene(instance, scene.root.single()):
    raise HTTPException(404, "实例不属于该场景")

# 3. 创建绑定ID和绑定对象
binding_id = str(uuid4())
binding = IoTBinding(
    id=binding_id,
    **binding_data.model_dump(exclude_unset=True)
)

# 4. 验证绑定配置
_validate_binding_config(binding)

# 5. 检查与已有绑定的冲突
current_bindings = instance.iot_binds or []
_validate_binding_conflicts(binding, current_bindings)

# 6. 更新实例的绑定列表（存储到 Neo4j）
current_bindings.append(binding.model_dump())
instance.iot_binds = current_bindings
instance.save()

return binding
```

**关键点**：
- **绑定ID**：自动生成 UUID
- **存储位置**：绑定配置存储在 `Instance.iot_binds`（Neo4j 的 JSONProperty）
- **验证**：验证绑定配置和冲突检查

---

## 四、第三步：绑定配置详解

### 1. 绑定映射关系（bindings）

**格式**：`[{source: 'iot.path', target: 'instance.path', direction: 0}]`

**source 字段格式规则**（iot_bindings.py 118-122）：

| 协议 + 数据类型 | source 格式 | 示例 |
|----------------|------------|------|
| MQTT + JSON | `{订阅路径}.{json对象key层级}` | `'sensor/temperature.data.value'` |
| MQTT + 其他 | `{订阅路径}` | `'sensor/temperature'` |
| WebSocket/HTTP + JSON | `{json对象key层级}` | `'data.value'` |
| WebSocket/HTTP + 其他 | 空字符串 | `''`（直接获取数据） |

**target 字段格式**：
- `'instance.transform.location.x'` - 实例位置X
- `'instance.transform.rotation.y'` - 实例旋转Y
- `'instance.properties.temperature'` - 实例属性

**direction 字段**：
- `0`：IoT → Instance（单向，数据从IoT流向实例）
- `1`：Instance → IoT（单向，数据从实例流向IoT）
- `2`：双向通信

**示例**：
```json
{
  "bindings": [
    {
      "source": "sensor/temperature.data.value",
      "target": "instance.transform.location.y",
      "direction": 0
    },
    {
      "source": "sensor/humidity",
      "target": "instance.properties.humidity",
      "direction": 0
    }
  ]
}
```

---

### 2. 数据处理配置

**数值映射（valueMapping）**：
```json
{
  "valueMapping": {
    "inputMin": 0.0,
    "inputMax": 100.0,
    "outputMin": 0.0,
    "outputMax": 1.0,
    "clamp": true
  }
}
```
作用：将 IoT 数据从 `[inputMin, inputMax]` 映射到 `[outputMin, outputMax]`。

**插值配置（interpolation）**：
```json
{
  "interpolation": {
    "type": "linear",
    "duration": 1.0,
    "easing": "ease-in-out"
  }
}
```
作用：平滑过渡数据变化（linear/smooth/step）。

**数据转换脚本（transform）**：
```json
{
  "transform": "value * 2 + 10"
}
```
作用：JavaScript 表达式，对数据进行转换。

---

### 3. 条件触发（conditions + triggerResults）

**触发条件**：
```json
{
  "conditions": [
    {
      "field": "data.temperature",
      "operator": "gt",
      "value": 30
    }
  ]
}
```

**触发结果**：
```json
{
  "triggerResults": [
    {
      "type": "animation",
      "target": "fan_animation",
      "params": {"speed": 1.5},
      "delay": 0
    }
  ]
}
```

作用：当满足条件时，触发动画、脚本、事件等。

---

## 五、第四步：前端连接数据源

### 1. 获取绑定配置

**接口**：`GET /scenes/{scene_id}/instances/{instance_id}/iot-bindings`  
**返回**：`List[IoTBinding]`（该实例的所有绑定配置）

### 2. 获取连接配置

**接口**：`GET /iot-connections/{connection_id}`（通过 `binding.sourceId` 查找）  
**返回**：连接配置（MQTT/WebSocket/HTTP 的连接信息）

### 3. 前端连接流程

**MQTT**：
```javascript
// 1. 获取绑定配置
const bindings = await getInstanceIoTBindings(sceneId, instanceId);

// 2. 获取连接配置
const connection = await getConnection(binding.sourceId);

// 3. 连接MQTT
const mqttClient = mqtt.connect({
  host: connection.config.host,
  port: connection.config.port,
  username: connection.config.username,
  password: connection.config.password
});

// 4. 订阅主题（从bindings中提取source路径）
mqttClient.subscribe('sensor/temperature');

// 5. 接收数据并更新实例
mqttClient.on('message', (topic, message) => {
  const data = JSON.parse(message);
  updateInstanceProperty(instanceId, 'transform.location.y', data.value);
});
```

**WebSocket**：
```javascript
// 1. 获取绑定和连接配置
const binding = await getInstanceIoTBinding(sceneId, instanceId, bindingId);
const connection = await getConnection(binding.sourceId);

// 2. 建立WebSocket连接
const ws = new WebSocket(connection.config.url);

// 3. 接收数据并更新实例
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateInstanceProperty(instanceId, binding.bindings[0].target, data.value);
};
```

**HTTP**：
```javascript
// 1. 获取绑定和连接配置
const binding = await getInstanceIoTBinding(sceneId, instanceId, bindingId);
const connection = await getConnection(binding.sourceId);

// 2. 轮询请求（如果配置了pollInterval）
setInterval(async () => {
  const response = await fetch(connection.config.base_url + '/api/data', {
    headers: connection.config.headers
  });
  const data = await response.json();
  updateInstanceProperty(instanceId, binding.bindings[0].target, data.value);
}, binding.httpConfig.pollInterval * 1000);
```

---

## 六、第五步：数据更新到实例

### 1. 更新实例属性

**接口**：`PUT /instances/{instance_id}`  
**请求体**：
```json
{
  "transform": {
    "location": [1, 2, 3],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1]
  },
  "properties": {
    "temperature": 25.5,
    "humidity": 60
  }
}
```

### 2. 数据处理流程

```
IoT数据
  ↓
[数据解析]（根据dataType解析JSON/text/number等）
  ↓
[source路径提取]（从bindings.source提取数据路径）
  ↓
[数值映射]（valueMapping：inputMin/Max → outputMin/Max）
  ↓
[数据转换]（transform：JavaScript表达式）
  ↓
[插值处理]（interpolation：平滑过渡）
  ↓
[条件检查]（conditions：是否满足触发条件）
  ↓
[更新实例属性]（target路径：instance.transform.location.x等）
  ↓
[触发结果]（triggerResults：动画、脚本、事件等）
```

---

## 七、完整示例

### 1. 创建MQTT连接

```json
POST /mqtt-connections
{
  "name": "温度传感器",
  "host": "mqtt.example.com",
  "port": 1883,
  "username": "user",
  "password": "pass"
}

返回：
{
  "_id": "507f1f77bcf86cd799439011"
}
```

### 2. 创建IoT绑定

```json
POST /scenes/scene123/instances/instance456/iot-bindings
{
  "name": "温度绑定",
  "protocol": "mqtt",
  "dataType": "json",
  "sourceId": "507f1f77bcf86cd799439011",
  "bindings": [
    {
      "source": "sensor/temperature.data.value",
      "target": "instance.transform.location.y",
      "direction": 0
    }
  ],
  "valueMapping": {
    "inputMin": 0,
    "inputMax": 100,
    "outputMin": 0,
    "outputMax": 10
  },
  "interpolation": {
    "type": "linear",
    "duration": 1.0
  }
}

返回：
{
  "id": "binding-uuid-123",
  "name": "温度绑定",
  "protocol": "mqtt",
  "dataType": "json",
  "sourceId": "507f1f77bcf86cd799439011",
  "bindings": [...],
  ...
}
```

### 3. 前端连接和更新

```javascript
// 1. 获取绑定配置
const bindings = await fetch('/scenes/scene123/instances/instance456/iot-bindings');
const binding = bindings[0];

// 2. 获取连接配置
const connection = await fetch(`/iot-connections/${binding.sourceId}`);

// 3. 连接MQTT
const mqttClient = mqtt.connect({
  host: connection.config.host,
  port: connection.config.port,
  username: connection.config.username,
  password: connection.config.password
});

// 4. 订阅主题
mqttClient.subscribe('sensor/temperature');

// 5. 接收数据并更新
mqttClient.on('message', async (topic, message) => {
  const data = JSON.parse(message);
  const value = data.data.value; // 从source路径提取
  
  // 数值映射
  const mappedValue = mapValue(value, binding.valueMapping);
  
  // 插值处理（前端实现）
  const interpolatedValue = interpolate(mappedValue, binding.interpolation);
  
  // 更新实例属性
  await fetch(`/instances/instance456`, {
    method: 'PUT',
    body: JSON.stringify({
      transform: {
        location: [1, interpolatedValue, 3]
      }
    })
  });
});
```

---

## 八、数据存储位置

| 数据 | 存储位置 | 说明 |
|------|----------|------|
| IoT连接配置 | **MongoDB** | mqtt_connections / websocket_connections / http_connections |
| IoT绑定配置 | **Neo4j** | Instance.iot_binds（JSONProperty） |
| 实例属性 | **Neo4j** | Instance.transform / Instance.properties |
| 历史数据 | **未实现** | 可集成时序数据库或MongoDB |

---

## 九、关键点总结

### 1. 绑定配置存储

- **位置**：`Instance.iot_binds`（Neo4j 的 JSONProperty）
- **格式**：`List[IoTBinding]`（绑定对象数组）
- **更新**：通过 `instance.save()` 保存到 Neo4j

### 2. 前端驱动模式

- **实时数据获取**：前端直接连接数据源（MQTT/WebSocket/HTTP）
- **数据更新**：前端接收数据后，调用更新实例接口
- **后端作用**：存储绑定配置，提供连接信息查询

### 3. 数据处理流程

- **数据解析**：根据 dataType 解析数据
- **路径提取**：从 bindings.source 提取数据路径
- **数值映射**：valueMapping 映射数值范围
- **数据转换**：transform 脚本转换数据
- **插值处理**：interpolation 平滑过渡
- **条件触发**：conditions + triggerResults 触发动作

### 4. 支持的协议

- **MQTT**：订阅/发布模式，实时推送
- **WebSocket**：双向通信，实时推送
- **HTTP**：轮询模式，定时请求

---

## 十、相关文件

| 说明 | 文件路径 |
|------|----------|
| IoT绑定模型 | `app/models/iot_bindings.py` |
| IoT绑定路由 | `app/routers/iot_bindings.py` |
| IoT连接路由 | `app/routers/iot_connections.py` |
| Instance模型 | `app/models/scene.py`（iot_binds字段） |

---

## 十一、小结

- **创建绑定**：POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings，配置协议、数据源、绑定映射等。
- **存储位置**：绑定配置存储在 `Instance.iot_binds`（Neo4j），连接配置存储在 MongoDB。
- **前端连接**：前端根据绑定配置连接数据源（MQTT/WebSocket/HTTP），接收数据并更新实例属性。
- **数据处理**：数据经过解析、映射、转换、插值等处理，最终更新到实例的 transform 或 properties。
- **前端驱动**：采用前端驱动模式，前端直接连接数据源，后端只负责存储配置和提供查询接口。
