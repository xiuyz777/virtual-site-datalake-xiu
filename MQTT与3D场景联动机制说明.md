# MQTT 与 3D 场景联动机制说明

本文档说明本系统中 **MQTT 消息如何驱动 3D 场景中模型属性的实时更新与持久化**，便于理解机制并用于团队分享。

---

## 一、概述

### 1.1 能力说明

系统支持将 **MQTT 消息** 与 **场景中的 3D 模型实例** 建立绑定关系：

- **实时更新**：收到 MQTT 消息后，按绑定规则从消息中取值，并更新对应模型在 Cesium 中的显示（位置、旋转、缩放、可见性、材质等）。
- **持久化**：更新后的属性会写入数据库（Neo4j），再次打开场景时，模型会按最新保存的状态加载。

### 1.2 整体流程（一句话）

**MQTT 消息 → 按绑定规则解析并取值 → 更新 Cesium 模型显示 → 节流后写回 Neo4j。**

下面按「概念 → 配置 → 数据流 → 关键组件 → 示例 → 验证」展开说明。

---

## 二、核心概念

### 2.1 MQTT 连接配置（数据源）

- **含义**：连接 MQTT Broker 所需的参数，如地址、端口、认证、WebSocket 路径等。
- **存储**：MongoDB，对应「数据管理」中的 MQTT 配置。
- **关键字段**（示例）：
  - `hostname`：Broker 地址（如 `broker.emqx.io`）
  - `port`：端口（如 8083，MQTT over WebSocket）
  - `websocket_path`：WebSocket 路径（如 `/mqtt`）
  - `topics`：可订阅的主题列表（用于管理端展示，实际订阅由绑定规则决定）
  - `username` / `password`：可选认证

前端通过 `mqttAPI.getMQTTById(sourceId)` 拉取某条 MQTT 配置的详情，用于建立连接。

### 2.2 IoT 绑定（Binding）

- **含义**：一条「数据源 + 协议 + 数据类型 + 若干条 源→目标 映射规则」的配置。
- **与场景的关系**：
  - 可按 **场景** 维度拉取：该场景下所有实例的绑定（`getSceneBindings(sceneId)`）。
  - 也可按 **实例** 维度拉取：某个实例的绑定（`getInstanceBindings(sceneId, instanceId)`）。
- **绑定结构**（简化）：
  - `protocol`：如 `mqtt`
  - `dataType`：如 `json`
  - `sourceId`：指向一条 MQTT 连接配置（MongoDB 中的 _id）
  - `bindings`：数组，每项为一条 **映射规则**，包含 `source` 和 `target`
  - `instanceId`：该绑定作用在哪个场景实例上（若为场景级绑定则可能没有或为 scene）

**映射规则**（`bindings[]` 中每一项）：

- **source（数据源路径）**：在 MQTT 场景下表示「订阅哪个主题 + 从消息 JSON 的哪个路径取值」。
  - 例如：`sensor.scale` 表示订阅主题 `sensor`，取值 `payload.scale`。
- **target（目标属性路径）**：模型上要更新的属性。
  - 例如：`scale`、`instance.transform.scale`、`instance.instance.transform.scale` 表示模型的缩放；
  - `visibility`、`rotation`、`location` 等表示可见性、旋转、位置。

绑定配置保存在 **Neo4j** 的 Instance 节点上：`Instance.iot_binds`（JSON 数组）。

### 2.3 连接池（Connection Pool）

- **含义**：按 **sourceId** 对绑定分组，同一个 MQTT 配置只建立 **一个** MQTT 连接，被多条绑定共享。
- **目的**：避免同一 Broker 被重复连接，控制连接数和资源占用。
- **流程**：
  1. 拉取当前场景（或实例）的 IoT 绑定；
  2. 按 `sourceId` 分组；
  3. 对每个 `sourceId` 拉取对应 MQTT 配置（`fetchConnectionConfigs`）；
  4. 为每个 `sourceId` 建立/维护一个 MQTT 客户端，并按其下所有绑定规则中解析出的 **主题** 去订阅。

因此：**一条 MQTT 配置（一个 sourceId）→ 一个连接 → 多个主题（由绑定规则中的 source 解析得到）。**

### 2.4 数据流中的两类「路径」

| 类型     | 含义                     | 示例                          |
|----------|--------------------------|-------------------------------|
| 数据源路径 | 主题 + JSON 路径         | `sensor.scale` → 主题 sensor，取 `scale` |
| 目标路径   | 模型属性路径             | `scale`、`instance.transform.scale` 等 |

解析 **数据源路径** 时，会得到：

- **topicPath**：要订阅的 MQTT 主题；
- **dataPath**：消息体（如 JSON）中取值的路径（如 `scale`、`a.b.c`）。

提取到值之后，再按 **目标路径** 更新 Cesium 模型和数据库。

---

## 三、配置层面：如何建立「MQTT → 模型」的绑定

### 3.1 前置条件

1. **MQTT 连接配置已创建**（数据管理 → MQTT），并记下其 ID（即后续绑定中的 `sourceId`）。
2. **场景中已有模型实例**，并记下实例 ID（用于绑定到具体实例）。

### 3.2 在场景编辑器中配置绑定

1. 进入场景编辑器，打开 **实例管理**，选中要绑定的实例。
2. 在实例的 **IoT 绑定** 中新增一条绑定，或编辑已有绑定。
3. 填写：
   - **协议**：MQTT
   - **数据类型**：如 JSON
   - **连接配置**：选择上面创建的 MQTT 配置（对应 `sourceId`）
   - **绑定规则**（可多条）：
     - **数据源路径（source）**：如 `sensor.scale`  
       表示：订阅主题 `sensor`，从消息 JSON 的 `scale` 字段取值。
     - **目标属性（target）**：如 `scale` 或 `instance.instance.transform.scale`  
       表示：把取到的值写到模型的对应属性上。

### 3.3 配置与运行时的对应关系

- **sourceId** → 用哪条 MQTT 配置建立连接；
- **source** → 订阅哪个主题、从消息里取哪个路径；
- **target** → 更新模型的哪个属性；
- **instanceId** → 更新哪个场景实例。

同一 MQTT 配置可被多条绑定共用；同一主题的一条消息，也可以被多条绑定规则处理（不同 target）。

---

## 四、运行时数据流（从收到消息到界面与数据库）

### 4.1 流程概览

```
[MQTT Broker] 发布 (topic, payload)
       ↓
[连接池] 对应 sourceId 的 MQTT 客户端收到 message 事件
       ↓
handlePoolData(sourceId, payload, topic)
       ↓
按 sourceId 找到该连接上的所有绑定（或从当前绑定列表查）
       ↓
对每条绑定的每条规则：
  - parseSourcePath(rule.source) → topicPath, dataPath
  - 若当前 topic 与 topicPath 匹配（或未指定 topic 则都处理）
  - IoTDataProcessor.processData(payload, dataType) → 解析为 JSON 等
  - DataBindingProcessor.extractValue(data, dataPath) → 得到 value
  - onInstanceUpdate(instanceId, rule.target, value)
       ↓
[场景编辑器] onInstanceUpdate 被调用
       ↓
根据 instanceId 找到 Cesium primitive，节流后 applyPropertyUpdate(primitive, target, value)
       ↓
更新 Cesium 模型（如 scale / rotation / location / visibility / material）
       ↓
persistInstanceUpdate(instanceId, target, value) 写入待持久化队列（节流）
       ↓
约 2 秒内无新更新则执行：getInstanceProperties → 合并 transform/properties → updateInstanceProperties
       ↓
[Neo4j] Instance 节点的 transform / properties 被更新
```

### 4.2 路径解析（parseSourcePath）说明

针对 **MQTT + JSON**，数据源路径 `source` 的约定：

- 若包含 **`.`** 且无 `/`：
  - **第一个点之前**：MQTT 主题（topicPath）
  - **第一个点之后**：JSON 路径（dataPath）
- 例如：`sensor.scale` → 订阅 `sensor`，取值 `payload.scale`；  
  `device.state.temperature` → 订阅 `device`，取值 `payload.state.temperature`。

这样，订阅主题和取值路径都从同一条 `source` 字符串解析出来，无需重复配置。

### 4.3 目标属性（target）与模型/数据库的对应

- **transform 相关**（会写入 Neo4j 的 `Instance.transform`）：
  - `scale`、`instance.transform.scale`、`instance.instance.transform.scale` → 缩放
  - `rotation`、`instance.transform.rotation`、… → 旋转
  - `location`、`position`、`instance.transform.location`、… → 位置
- **可见性**：`visibility` / `visible` → 对应 Cesium 的 `show`，并写入 `Instance.properties.visibility`。
- **材质**：`material.xxx` → 写入 `Instance.properties.material` 下对应字段。

持久化时，会根据 target 的类型决定是合并进 `transform` 还是 `properties`，避免覆盖其他字段。

### 4.4 节流策略

- **渲染更新**：同一实例的 `onInstanceUpdate` 有 33ms 间隔限制（约 30fps），避免过于频繁刷新 Cesium。
- **持久化**：同一实例的写库请求会进入队列，2 秒内只执行最后一次的「合并写」，既保证最终一致，又降低数据库压力。

---

## 五、关键代码位置（便于阅读与分享）

以下仅作「机制说明」用，不涉及具体实现细节与变更历史。

| 环节           | 说明                     | 文件/位置概览 |
|----------------|--------------------------|-------------------------------|
| 绑定与配置拉取 | 按场景/实例拉取绑定、拉取 MQTT 配置 | `usePreviewMode.ts`：`fetchSceneBindings` / `fetchIoTBindings`、`fetchConnectionConfigs` |
| 连接池         | 按 sourceId 分组、建连接、订阅主题 | `usePreviewMode.ts`：`buildConnectionPool`、`connectMQTTToPool`、订阅逻辑 |
| 消息接收       | 收到 message 后统一入口   | `usePreviewMode.ts`：MQTT 客户端的 `on('message')` → `handlePoolData` |
| 数据处理       | 按绑定规则解析、取值、回调 | `usePreviewMode.ts`：`handlePoolData`、`processIoTDataAndUpdateInstance` |
| 路径解析       | source → topicPath + dataPath | `usePreviewMode.ts`：`parseSourcePath` |
| 取值           | 从 JSON 等中按 dataPath 取值 | `iotDataProcessor.ts`：`DataBindingProcessor.extractValue` |
| 模型更新       | 根据 target 更新 Cesium 模型 | `SceneEditorStandalone.tsx`：`onInstanceUpdate`、`applyPropertyUpdate`、`updateModelScale` 等 |
| 持久化         | 节流、合并、写库          | `SceneEditorStandalone.tsx`：`persistInstanceUpdate`；`sceneApi.ts`：`updateInstanceProperties`、`getInstanceProperties` |
| 数据模型       | 实例的 transform、properties、iot_binds | `app/models/scene.py`：`Instance`；Neo4j 中对应节点属性 |

---

## 六、端到端示例（便于分享与演示）

### 6.1 目标效果

- MQTT 主题 `sensor` 收到 `{ "scale": [1, 3, 5] }`。
- 场景中某模型实例的缩放实时变为 [1, 3, 5]，并在约 2 秒后写入数据库；再次打开场景时，模型以该缩放显示。

### 6.2 配置步骤（简述）

1. **数据管理 → MQTT**：新建连接，Broker 如 `broker.emqx.io:8083`，保存得到 `sourceId`。
2. **场景编辑器 → 实例管理**：选中目标实例，在 IoT 绑定中新增绑定：
   - 协议：MQTT；数据类型：JSON；
   - 连接配置：选刚建的 MQTT；
   - 绑定规则：数据源路径 `sensor.scale`，目标属性 `scale`（或 `instance.instance.transform.scale`）。
3. 保存后进入 **预览**，连接池会为该 `sourceId` 建立连接并订阅 `sensor`。

### 6.3 发送消息

- 使用任意 MQTT 客户端向 Broker 发布：
  - Topic：`sensor`
  - Payload：`{ "scale": [1, 3, 5] }`（JSON 字符串）。

### 6.4 系统侧发生的事（概念层面）

1. 连接池中该 sourceId 的客户端收到 `(topic=sensor, payload='{"scale":[1,3,5]}')`。
2. `handlePoolData` 被调用，找到该连接对应的绑定及规则。
3. 对规则 `source=sensor.scale`：解析得 topicPath=`sensor`、dataPath=`scale`；解析 payload 为 JSON；`extractValue(data, 'scale')` 得到 `[1, 3, 5]`。
4. 调用 `onInstanceUpdate(instanceId, 'scale', [1,3,5])`，场景编辑器更新对应 Cesium 模型的 scale。
5. `persistInstanceUpdate` 将该更新加入队列，2 秒内无新更新则执行：读取当前 Instance 属性，合并 `transform.scale = [1,3,5]`，调用 `updateInstanceProperties` 写回 Neo4j。

---

## 七、如何验证机制是否打通

1. **连接与订阅**：在浏览器控制台或网络面板确认 MQTT 连接建立、无鉴权/网络错误；若有调试日志，可确认订阅了预期主题。
2. **实时更新**：发送上述 MQTT 消息后，3D 视图中对应模型应在短时间内看到缩放（或所配 target）变化。
3. **持久化**：等待约 2 秒后，在 Neo4j 中查询该 Instance 的 `transform.scale`（或对应属性），应为最新值；刷新页面重新打开场景，模型应保持该状态。
4. **多实例/多规则**：可为不同实例、不同 target 配置多条规则，同一主题、同一消息可驱动多个模型属性，便于做联动演示。

---

## 八、小结（可作分享用）

- **MQTT 配置**：描述「连哪个 Broker、怎么连」，存在 MongoDB。
- **IoT 绑定**：描述「用哪条 MQTT 配置、订阅什么、取哪个路径、更新哪个实例的哪个属性」，绑定存在 Neo4j 的 Instance 上。
- **连接池**：同一 MQTT 配置只建一个连接，按绑定规则解析出主题并订阅，收到消息后按规则解析、取值、回调。
- **数据源路径**：在 MQTT+JSON 下，用「主题.JSON路径」的形式同时决定订阅与取值。
- **目标路径**：决定更新 Cesium 的哪项属性，以及写回 Neo4j 的 `transform` 还是 `properties`。
- **节流**：渲染 33ms、持久化 2 秒，兼顾实时性与数据库压力。
- **闭环**：MQTT 消息 → 解析与取值 → 更新 3D 模型 → 节流后写回数据库，形成「订阅 → 展示 → 持久化」的完整闭环。

若需要，可在此基础上再补充「故障排查」或「安全与权限」等章节用于内部分享。
