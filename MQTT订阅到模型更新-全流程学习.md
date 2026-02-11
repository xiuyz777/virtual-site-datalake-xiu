# MQTT 订阅 → IoT 绑定 → 模型更新：全流程学习

按「收到 MQTT 消息 → 按绑定规则取数 → 更新 3D 模型」整条链路，逐步对照代码学习。建议按下面顺序读。

---

## 一、流程总览（一句话）

**进入预览 → 拉取场景的 IoT 绑定和 MQTT 配置 → 按 sourceId 建连接池、订阅主题 → 收到 message → 按每条绑定的 source/target 解析取值 → 回调 onInstanceUpdate(instanceId, target, value) → 场景里找到对应 Cesium 模型 → applyPropertyUpdate 改显示 → persistInstanceUpdate 节流写 Neo4j。**

---

## 二、阶段 1：进入预览时，绑定和连接从哪来

### 2.1 拉取场景下所有 IoT 绑定

- **文件**：`web/src/hooks/usePreviewMode.ts`
- **函数**：`fetchSceneBindings`（约 359–380 行）

**逻辑**：
- 有 `sceneId` 时调用 `iotBindingAPI.getSceneBindings(sceneId)`，得到该场景下所有实例的绑定列表（每条绑定带 sourceId、protocol、dataType、bindings 数组等）。
- 结果存入 `setIoTBindings(bindings)`。
- 从绑定里抽出所有不重复的 `sourceId`，再调 `fetchConnectionConfigs(sourceIds, bindings)`。

**对应概念**：IoT 绑定存在 Neo4j 的 Instance 上；这里是从后端 API 把「当前场景用到的所有绑定」拉到前端。

---

### 2.2 按 sourceId 拉取 MQTT 等连接配置

- **文件**：同上 `usePreviewMode.ts`
- **函数**：`fetchConnectionConfigs`（约 385–418 行）

**逻辑**：
- 对每个 `sourceId`，根据绑定里的 `protocol`（mqtt / websocket / http）调对应 API，例如 MQTT 时：`mqttAPI.getMQTTById(sourceId)`，得到 Broker 地址、端口、认证等。
- 结果放进 `connectionConfigs` 的 Map（sourceId → config），后面建连接时用。

**对应概念**：MQTT 配置在 MongoDB；这里把「绑定里引用到的数据源」的配置都取回来。

---

### 2.3 构建连接池：按 sourceId 分组绑定

- **文件**：同上 `usePreviewMode.ts`
- **函数**：`buildConnectionPool`（约 434–505 行）

**逻辑**：
- 把 `iotBindings` 里 enabled 的绑定按 `sourceId` 分组到 `pool.bindingGroups`。
- 对每个 sourceId，若已有 connection 就更新其 bindings，否则新建一个 `IoTConnection`（sourceId、protocol、config、bindings），放进 `pool.connections`。
- 没有绑定再用的 sourceId 会断开并从池里删掉。

**对应概念**：一个 MQTT 配置（一个 sourceId）只对应一个连接，多条绑定共用。

---

### 2.4 启动连接池：为每个 sourceId 建 MQTT 连接并订阅

- **文件**：同上 `usePreviewMode.ts`
- **函数**：`connectMQTTToPool`（约 744 行起，到约 878 行 message 回调）

**逻辑**：
- 用 `connection.config`（来自 fetchConnectionConfigs）拼出 Broker 的 WebSocket URL，`mqtt.connect(...)` 建一个 MQTT 客户端。
- 在 `client.on('connect')` 里：
  - 从 `config.topics` 和 **当前 connection 下所有绑定的规则** 里，用 `parseSourcePath(rule.source, ...)` 取出 `topicPath`，收集到 `topics` 集合。
  - 对每个 topic 执行 `client.subscribe(topic, { qos: 0 }, ...)`，完成订阅。
- **关键**：`client.on('message', async (topic, payload, packet) => { ... })`（约 881–924 行）：
  - `payload.toString()` 得到消息字符串。
  - 调用 **`handlePoolData(sourceId, message, topic)`**，把「这条消息」交给后续的绑定处理逻辑。

**对应概念**：MQTT 收到订阅消息的入口就在这里；之后整条链路都从 `handlePoolData` 开始。

---

## 三、阶段 2：收到一条 MQTT 消息后，怎么按绑定规则处理

### 3.1 统一入口：handlePoolData

- **文件**：`web/src/hooks/usePreviewMode.ts`
- **函数**：`handlePoolData`（约 669–635 行）

**逻辑**：
- 参数：`sourceId`（哪条 MQTT 连接）、`rawData`（消息体字符串）、`topic`（当前主题）。
- 从连接池里取 `connection = pool.connections.get(sourceId)`；若没有则尝试用 `iotBindings` 里该 sourceId 的绑定列表直接处理。
- 对 connection 下的 **所有 binding** 循环：`await processIoTDataAndUpdateInstance(binding, rawData, topic)`。
- 即：**一条 MQTT 消息会驱动「使用该 sourceId 的每一条绑定」**，每条绑定里又可能有多条规则（source/target）。

---

### 3.2 单条绑定的处理：processIoTDataAndUpdateInstance

- **文件**：同上 `usePreviewMode.ts`
- **函数**：`processIoTDataAndUpdateInstance`（约 102–237 行）

**逻辑**：
1. **解析原始数据**：`IoTDataProcessor.processData(rawData, binding.dataType)`（如 JSON 则 `JSON.parse`），得到 `processedData.data`（例如一个对象）。
2. **遍历该绑定的每条规则** `binding.bindings`（每条有 source、target）：
   - **解析 source**：`parseSourcePath(rule.source, topic, binding.protocol, binding.dataType)` → 得到 `topicPath`、`dataPath`、`matches`。若当前 `topic` 与 `topicPath` 不匹配则跳过本条规则。
   - **按 dataPath 取值**：`DataBindingProcessor.extractValue(processedData.data, dataPath)`（在 `web/src/utils/iotDataProcessor.ts` 约 406 行），得到 `sourceValue`。
   - 若有 valueMapping 可做数值映射。
   - **调用回调**：`callbacksRef.current.onInstanceUpdate?.(bindingInstanceId, bindingRule.target, mappedValue)`，即把「哪个实例、哪个属性、什么值」交给场景编辑器。

**对应概念**：这里完成「IoT 数据绑定到模型」：用绑定的 source 从消息里取值，用 target 指明要更新哪个实例的哪个属性，通过 onInstanceUpdate 交给 3D 侧。

---

### 3.3 路径解析：parseSourcePath（source → 主题 + 取值路径）

- **文件**：同上 `usePreviewMode.ts`
- **函数**：`parseSourcePath`（约 243–312 行）

**逻辑**（MQTT + JSON 且 source 不含 `/` 时）：
- 第一个点之前：**MQTT 主题**（topicPath），用于订阅和与当前 message 的 topic 匹配。
- 第一个点之后：**JSON 取值路径**（dataPath），如 `sensor.scale` → topicPath=`sensor`，dataPath=`scale`；消息体 `{ "scale": [1,3,5] }` 就取 `scale` 得到 `[1,3,5]`。

**对应概念**：数据源路径（source）同时决定「订阅谁」和「从消息里取哪一段」。

---

### 3.4 按路径取值：DataBindingProcessor.extractValue

- **文件**：`web/src/utils/iotDataProcessor.ts`
- **位置**：`DataBindingProcessor.extractValue(data, path)` 约 406–437 行

**逻辑**：支持 `a.b.c`、`arr[0]` 等路径，从已解析好的 JSON 对象里取出对应值。MQTT 场景里通常 path 就是 dataPath（如 `scale`）。

---

## 四、阶段 3：场景编辑器里如何更新模型

### 4.1 回调入口：onInstanceUpdate

- **文件**：`web/src/pages/Scenes/SceneEditorStandalone.tsx`
- **位置**：传给 usePreviewMode 的 `onInstanceUpdate`（约 486–534 行）

**逻辑**：
- 参数：`(instanceId, property, value)`，即「要更新哪个实例、哪个属性、什么值」。
- 若 `instanceId === 'scene'`，对缓存里所有 primitive 调 `applyPropertyUpdate(primitive, property, value, primitiveId)`（场景级绑定）。
- 否则从 `primitiveCache.current.get(instanceId)` 取到 Cesium 的 primitive；有 33ms 节流，然后调 **`applyPropertyUpdate(primitive, property, value, instanceId)`**。

**对应概念**：这里把「IoT 绑定得到的 (instanceId, target, value)」接到具体 Cesium 对象上。

---

### 4.2 按属性类型更新 Cesium：applyPropertyUpdate

- **文件**：同上 `SceneEditorStandalone.tsx`
- **函数**：`applyPropertyUpdate`（约 657–884 行）

**逻辑**：
- 根据 `property`（即绑定里的 target）做 switch：
  - `scale` / `instance.transform.scale` 等 → `updateModelScale(primitive, value, ...)`
  - `rotation` / `instance.transform.rotation` 等 → `updateModelRotation(...)`
  - `location` / `position` / `instance.transform.location` 等 → `updateModelPosition*`
  - `visibility` / `visible` → `primitive.show = Boolean(value)`
  - `material.xxx` → `updateModelMaterial(...)`
- 最后调 **`persistInstanceUpdate(targetInstanceId, property, value)`**，把更新在节流后写回 Neo4j。

**对应概念**：这里完成「更新模型」的视觉部分；同时触发持久化。

---

### 4.3 持久化到 Neo4j：persistInstanceUpdate

- **文件**：同上 `SceneEditorStandalone.tsx`
- **函数**：`persistInstanceUpdate`（约 547–654 行）

**逻辑**：
- 把 (instanceId, property, value) 放进 `pendingPersistValues`，并设 2 秒节流定时器。
- 2 秒内若没有同一实例的新更新，则执行：用 `getInstanceProperties(instanceId)` 拉当前 transform/properties，按 property 合并（scale/rotation/location 进 transform，visibility/material 等进 properties），再 `updateInstanceProperties(instanceId, updateData)` 写回后端，后端更新 Neo4j 的 Instance 节点。

**对应概念**：模型不仅在画面里更新，还会写回数据库，下次打开场景时保持最新状态。

---

## 五、建议阅读顺序（按数据流）

1. **usePreviewMode.ts**  
   - `fetchSceneBindings`（359）→ `fetchConnectionConfigs`（385）→ `buildConnectionPool`（434）→ `connectMQTTToPool`（744，重点看 `client.on('message')` 调 `handlePoolData`）。
2. **usePreviewMode.ts**  
   - `handlePoolData`（669）→ `processIoTDataAndUpdateInstance`（102）→ `parseSourcePath`（243）。
3. **iotDataProcessor.ts**  
   - `DataBindingProcessor.extractValue`（406）。
4. **SceneEditorStandalone.tsx**  
   - `onInstanceUpdate`（486）→ `applyPropertyUpdate`（657）→ `persistInstanceUpdate`（547）。

---

## 六、一条消息的完整路径（小结）

| 步骤 | 位置 | 做什么 |
|------|------|--------|
| 1 | usePreviewMode：client.on('message') | 收到 (topic, payload)，调 handlePoolData(sourceId, message, topic) |
| 2 | handlePoolData | 对该 sourceId 下每条 binding 调 processIoTDataAndUpdateInstance |
| 3 | processIoTDataAndUpdateInstance | 解析数据 → parseSourcePath(source) → extractValue(data, dataPath) → onInstanceUpdate(instanceId, target, value) |
| 4 | SceneEditorStandalone：onInstanceUpdate | 根据 instanceId 取 primitive，节流后 applyPropertyUpdate(primitive, property, value) |
| 5 | applyPropertyUpdate | 按 property 更新 Cesium（scale/rotation/location/visibility/material 等），并调 persistInstanceUpdate |
| 6 | persistInstanceUpdate | 节流 2 秒后合并当前实例属性，调用 updateInstanceProperties 写 Neo4j |

按上述顺序在代码里走一遍，就能把「MQTT 得到订阅消息 → IoT 数据绑定到模型 → 更新模型」整条流程学通。
