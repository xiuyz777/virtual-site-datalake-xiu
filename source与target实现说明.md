# bindings[].source → target 具体实现说明

本文说明：**「从 MQTT 主题/路径（source）取数 → 写到实例属性（target）」** 在现有项目里是谁做的、怎么做。

---

## 一、结论先说

- **后端当前不做**「收到 MQTT 后按 source 解析、再按 target 写实例」。
- 后端只做两件事：
  1. **存绑定配置**：把 `bindings[].source` 和 `bindings[].target` 存进 `Instance.iot_binds`（Neo4j）。
  2. **提供更新接口**：`PUT /instances/{instance_id}`，用请求体里的 `transform`、`properties` 等更新实例。
- **真正实现 source → target 的，是前端**（或你自己加的后台服务）：前端连 MQTT、收消息、按 source 取数、按 target 拼请求体、调 `PUT /instances/{instance_id}`。

项目里 `app/iot/mqtt_gateway.py` 和 `connection_pool.py` 已标记为 deprecated，说明改为「前端驱动」：后端只存配置，不负责把 MQTT 数据推到实例上。

---

## 二、后端已经提供的「材料」

### 1. 绑定配置存在哪、长什么样

- **位置**：Neo4j 里该实例的 `Instance.iot_binds`（JSON 数组）。
- **单条绑定里和实现相关的字段**（见 `app/models/iot_bindings.py`）：
  - `protocol`：如 `"mqtt"`
  - `dataType`：如 `"json"`
  - `sourceId`：MQTT 配置的 _id（用来拿连接信息）
  - `bindings`：`[{ "source": "主题或主题.路径", "target": "instance.xxx.yyy", "direction": 0 }]`
  - 可选：`valueMapping`、`interpolation`、`transform`（脚本）等。

前端（或你的服务）通过 **GET /scenes/{scene_id}/instances/{instance_id}/iot-bindings** 拿到这些配置。

### 2. 更新实例的接口（写 target 的入口）

**PUT /instances/{instance_id}**（`app/routers/scene.py`）：

```python
# 请求体 InstanceUpdate：transform、properties 等均为可选
if data.transform:
    inst.transform = data.transform
if data.properties:
    inst.properties = data.properties
# ... 其他字段
inst.save()
```

也就是说：**谁想实现 source → target，谁就按 target 的含义，拼好 `transform` 或 `properties`，调这个 PUT**。

---

## 三、source → target 的实现思路（谁来做、怎么做）

整体流程可以分成几步，这几步**不在当前后端代码里**，需要在前端（或自建服务）里实现。

### 步骤 1：从消息里按 source 取出值

- **source 格式**（MQTT + JSON）：`"主题.data.value"` 表示「该主题下消息体的 `data.value`」。
- 实现方式：
  - 主题部分：用来订阅 MQTT 主题（或匹配当前收到的主题）。
  - 点号后的路径：对消息体做「按路径取值」，例如 JSON 用 `msg.data.value`，或通用一点用 `path.split('.')` 逐层取。

示例（JavaScript 思路，前端常用）：

```javascript
// 假设 source = "sensor/temperature.data.value"，消息 payload = { data: { value: 25.5 } }
function getValueBySource(payload, source, dataType) {
  if (dataType === 'json') {
    const parts = source.split('.');
    const topic = parts[0];           // 主题，订阅用
    const path = parts.slice(1);     // ["data", "value"]
    let v = payload;
    for (const key of path) v = v?.[key];
    return v;
  }
  return payload;  // 非 JSON 时整包就是值
}
```

（若 source 只写主题、不写路径，则 path 为空，整包当值。）

### 步骤 2：可选——数值映射与插值

- 若绑定里配置了 **valueMapping**（inputMin/Max、outputMin/Max），把上一步得到的数值线性映射到目标范围。
- 若需要**插值**（interpolation），在前端对「当前值 → 目标值」做时间上的平滑（如 linear），再在下一帧或定时用插值结果去更新。

### 步骤 3：按 target 拼出要写给实例的数据

- **target** 形如：`instance.transform.location.y`、`instance.properties.温度`。
- 约定（与当前后端一致）：
  - `instance.transform.*` → 对应 **PUT 请求体里的 `transform`**，结构如 `{ location: [x,y,z], rotation: [x,y,z], scale: [x,y,z] }`。
  - `instance.properties.*` → 对应 **PUT 请求体里的 `properties`**，如 `{ "温度": 25.5 }`。

实现时：根据 target 字符串解析出「是 transform 还是 properties」「具体哪个子路径」，然后：

- 要么先 GET 当前实例，在本地合并要改的那一维（例如只改 `transform.location[1]`），再 PUT 整份 `transform`；
- 要么前端/服务端自己维护该实例的 transform/properties 缓存，只改其中一维再 PUT。

示例（只表达「怎么从 target 决定写哪一块」）：

```javascript
// target 例如 "instance.transform.location.y"
function buildUpdateFromTarget(target, value) {
  const parts = target.replace(/^instance\./, '').split('.');
  if (parts[0] === 'transform') {
    // 这里需要当前 transform，只改其中一个分量
    return { transform: { location: [currentX, value, currentZ], rotation: [...], scale: [...] } };
  }
  if (parts[0] === 'properties') {
    const key = parts.slice(1).join('.');
    return { properties: { ...currentProperties, [key]: value } };
  }
  return {};
}
```

（实际要配合当前实例的 transform/properties 做合并，避免覆盖未绑定的字段。）

### 步骤 4：调用 PUT /instances/{instance_id}

- 把上一步得到的 `transform` 和/或 `properties` 放进请求体，带登录态调：

```http
PUT /instances/{instance_id}
Content-Type: application/json

{ "transform": { ... }, "properties": { ... } }
```

后端就会把对应实例的 `transform`、`properties` 更新到 Neo4j，3D 场景里该模型就会跟着变。

---

## 四、前端完整链路小结（具体怎么实现）

1. **拉绑定**：`GET /scenes/{scene_id}/instances/{instance_id}/iot-bindings` → 得到每个绑定的 `protocol`、`sourceId`、`dataType`、`bindings`（含 source/target）、valueMapping 等。
2. **拉 MQTT 连接信息**：用 `sourceId` 调 `GET /mqtt/{sourceId}`，拿到 hostname、port、username、password 等，用来建 MQTT 连接。
3. **连 MQTT、订阅**：从每个 binding 的 `bindings[].source` 里解析出主题（第一个点之前或整个 source），订阅这些主题。
4. **收消息**：
   - 按 `dataType` 解析 payload（如 JSON.parse）。
   - 对每条 `bindings[]`：用 **source** 从 payload 里取值（步骤 1）；可选做 valueMapping/插值（步骤 2）；用 **target** 拼出要更新的 `transform`/`properties`（步骤 3）；**PUT /instances/{instance_id}**（步骤 4）。

这样，**bindings[].source → 主题/路径取数** 和 **bindings[].target → 实例属性** 就在前端（或你实现该逻辑的服务）里具体实现了；后端只负责存配置和提供更新实例的 API。

---

## 五、若要在后端实现 source → target（可选）

如果希望「后端收到 MQTT 后自动写实例」，需要新增一个**订阅 MQTT 的服务**（或复用/改造已废弃的 mqtt_gateway），在收到消息时：

1. 根据主题或 connection 找到所有「使用该 MQTT 配置且 source 匹配」的绑定（需要查 Neo4j 里带 `iot_binds` 的实例，或维护 binding_id → instance_id 的映射）。
2. 对每个绑定：用上面同一套逻辑——按 source 解析值、valueMapping、按 target 拼 transform/properties。
3. 在后端调「更新实例」的逻辑（直接调 scene 的 update_instance 或写 Neo4j），而不是发 HTTP。

当前代码库**没有**这段逻辑，所以文档里只写「前端实现」；若你加后端实现，算法与上面一致，只是执行环境从浏览器换到服务器。

---

## 六、相关代码位置

| 作用 | 位置 |
|------|------|
| 绑定配置模型（source/target 含义） | `app/models/iot_bindings.py`（IoTBinding.bindings） |
| 存绑定到实例 | `app/routers/iot_bindings.py`（create_instance_iot_binding：instance.iot_binds.append(binding.model_dump()); instance.save()） |
| 更新实例（写 target 的入口） | `app/routers/scene.py`（update_instance：data.transform / data.properties → inst.transform / inst.properties；inst.save()） |

总结：**source → target 的「具体实现」= 前端（或自建服务）连 MQTT、按 source 取值、按 target 拼 body、调 PUT /instances/{instance_id}；后端只提供配置存储和更新接口。**
