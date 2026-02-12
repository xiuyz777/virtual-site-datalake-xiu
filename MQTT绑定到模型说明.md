# 通过 MQTT 绑定 IoT 与模型（实例）说明

MQTT 配置完成后，下一步是：**创建 IoT 绑定**，把 MQTT 数据源和**场景里的某个实例（模型）**关联起来，这样前端才能按“主题 → 实例属性”的规则把数据驱动到 3D 上。

---

## 一、整体关系

```
MQTT 配置（mqtt_sources 里的一条，有 _id）
    ↓ sourceId 引用
IoT 绑定（挂在「场景 + 实例」上，存于 Instance.iot_binds）
    ↓ bindings[].source → 主题/路径
    ↓ bindings[].target → 实例属性（如 transform、properties）
实例（模型）
```

- **模型** = 场景里的一个 **Instance**（有 uid、name、asset_id、transform、properties 等）。
- **绑定** = 在这个 Instance 上创建一条 IoT 绑定，指定：用哪个 MQTT 数据源（sourceId）、MQTT 里哪个数据（source）写到实例的哪个属性（target）。

---

## 二、前置条件

1. **已有 MQTT 配置**：`POST /mqtt/` 已调用成功，拿到返回里的 **`_id`**（ObjectId），记作 **sourceId**，例如 `"507f1f77bcf86cd799439011"`。
2. **已有场景**：`POST /scenes` 创建过场景，有 **scene_id**（Scene 的 uid）。
3. **已有实例（模型）**：`POST /scenes/{scene_id}/instances` 创建过实例，有 **instance_id**（Instance 的 uid）。这个实例就是你要用 MQTT 数据驱动的那个“模型”。

---

## 三、创建绑定接口（把 MQTT 绑到该实例）

**路径**：`POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings`  
**文件**：`app/routers/iot_bindings.py`（create_instance_iot_binding）

**路径参数**：

| 参数         | 说明 |
|--------------|------|
| scene_id     | 场景 uid |
| instance_id  | 实例（模型）uid |

**请求体**：`IoTBindingCreate`，其中和 MQTT 强相关、必填/常用的字段如下。

---

## 四、请求体要点（MQTT → 模型）

### 1. 数据源与协议

```json
{
  "protocol": "mqtt",
  "dataType": "json",
  "sourceId": "这里填 MQTT 配置返回的 _id 字符串"
}
```

- **protocol**：`"mqtt"` 表示用 MQTT 数据源。
- **sourceId**：MQTT 配置创建后返回的 **`_id`** 转成字符串，对应 MongoDB `mqtt_sources` 里那条文档。
- **dataType**：`"json"` 表示消息按 JSON 解析；还可选 `text`、`number`、`boolean` 等（见 `IoTDataType`）。

### 2. 绑定映射：MQTT 数据 → 实例属性

```json
{
  "bindings": [
    {
      "source": "sensor/temperature.data.value",
      "target": "instance.transform.location.y",
      "direction": 0
    }
  ]
}
```

**source（数据从哪来）**——MQTT 规则（见 `app/models/iot_bindings.py` 说明）：

- **dataType 为 json**：`"主题. JSON 路径"`，例如：
  - `"sensor/temperature"`：主题
  - `"sensor/temperature.data.value"`：主题 + 取 `data.value`
- **dataType 非 json**：只写主题，如 `"sensor/temperature"`。

**target（写到模型的哪）**——实例属性路径，常用：

- 位置：`instance.transform.location.x` / `.y` / `.z`
- 旋转：`instance.transform.rotation.x` / `.y` / `.z`
- 缩放：`instance.transform.scale.x` / `.y` / `.z`
- 自定义：`instance.properties.温度`、`instance.properties.开关` 等

**direction**：`0` = IoT→实例（只读 MQTT 写模型），`1` = 实例→IoT，`2` = 双向。

---

## 五、完整请求示例（MQTT 绑定到模型）

假设：

- 场景 id：`scene_abc`
- 实例（模型）id：`instance_xyz`
- MQTT 配置返回的 _id：`507f1f77bcf86cd799439011`
- MQTT 主题：`sensor/temperature`，消息格式：`{"data":{"value": 25.5}}`
- 希望：用 `data.value` 驱动模型的 **位置 Y**（或某个自定义属性）

**创建绑定**：

```http
POST /scenes/scene_abc/instances/instance_xyz/iot-bindings
Content-Type: application/json

{
  "name": "温度驱动模型Y",
  "protocol": "mqtt",
  "dataType": "json",
  "sourceId": "507f1f77bcf86cd799439011",
  "bindings": [
    {
      "source": "sensor/temperature.data.value",
      "target": "instance.transform.location.y",
      "direction": 0
    }
  ]
}
```

可选：加 **valueMapping** 把 0~100 映射到 0~10（例如高度）：

```json
{
  "name": "温度驱动模型Y",
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
    "outputMax": 10,
    "clamp": true
  }
}
```

---

## 六、后端在做什么（和模型的关系）

- 校验：场景存在且属于当前用户，实例存在且属于该场景。
- 生成绑定的 **id**（UUID），与请求体一起组成一条 **IoTBinding**。
- 校验配置（如 HTTP 时要有 httpConfig、bindings 的 source/target 合法、同实例下 target 不重复等）。
- 把这条绑定 **append 到该实例的 `iot_binds`**，并 **instance.save()** 写回 Neo4j。

所以：**绑定是挂在「场景 + 实例」上的**；一个实例可以有多条绑定（不同 target），每条绑定用同一个或不同 MQTT 配置（sourceId）都可以。

---

## 七、前端如何用这条绑定驱动模型

1. **拉绑定**：`GET /scenes/{scene_id}/instances/{instance_id}/iot-bindings`，得到该实例的所有绑定（含 protocol、sourceId、bindings）。
2. **拉 MQTT 连接信息**：用绑定里的 **sourceId** 调 `GET /mqtt/{sourceId}`（即 MQTT 配置的 _id），拿到 hostname、port、username、password、topics 等。
3. **连 MQTT**：用上述配置连接 broker，订阅 bindings 里用到的主题（如从 `source` 解析出 `sensor/temperature`）。
4. **收消息 → 写实例**：按 `dataType` 解析消息，按 `bindings[].source` 取数值，按 `bindings[].target` 知道要改哪个属性；若有 valueMapping 先做映射；最后调 **`PUT /instances/{instance_id}`** 更新该实例的 `transform` 或 `properties`，3D 里的模型就会动起来。

---

## 八、小结

- MQTT 配置完成后，**用「创建 IoT 绑定」把 MQTT 和「模型」（Instance）连起来**。
- 绑定接口：**POST /scenes/{scene_id}/instances/{instance_id}/iot-bindings**，请求体里 **protocol=mqtt、sourceId=MQTT 的 _id、bindings 里 source（主题+路径）和 target（实例属性）**。
- **模型** = 场景下的一个 **Instance**；绑定挂在这个 instance 上，数据最终通过 **PUT /instances/{instance_id}** 更新到该实例，从而驱动 3D 模型。

这样你就完成了「MQTT → IoT 绑定 → 模型」的整条链路；若要再细化某一步（例如 bindings 的更多写法或 nodeBindings 骨骼绑定），可以指定哪一块。
