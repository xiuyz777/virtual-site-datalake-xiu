# MQTT 与 3D 场景联动 — 代码学习路线

配合 **《MQTT与3D场景联动机制说明.md》** 使用：按文档章节顺序，对照下面列出的文件与行号阅读代码，理解每一部分的实现逻辑。

---

## 一、对应文档「概述」与「核心概念」

### 1.1 数据从哪里来、存哪里

| 概念 | 代码位置 | 说明 |
|------|----------|------|
| **MQTT 连接配置（MongoDB）** | 前端拉取：`web/src/services/mqttApi.ts`（如 `getMQTTById`） | 数据管理里创建的 MQTT 配置，前端用 sourceId 拉取 |
| **IoT 绑定（Neo4j Instance.iot_binds）** | 后端模型：`app/models/scene.py` 第 88–110 行 `Instance` | `iot_binds` 为 JSON 数组，存绑定列表 |
| **按场景/实例拉取绑定** | `web/src/services/iotBindingApi.ts` 第 221–226 行 | `getSceneBindings(sceneId)`、`getInstanceBindings(sceneId, instanceId)` |

建议先看：`app/models/scene.py` 里 `Instance` 的 `transform`、`properties`、`iot_binds` 定义，建立「绑定在实例上、持久化写回 transform/properties」的印象。

---

## 二、对应文档「配置层面」— 绑定如何建立

### 2.1 前端：场景编辑器中配置绑定

| 功能 | 文件 | 位置/说明 |
|------|------|------------|
| IoT 绑定弹窗、规则编辑 | `web/src/components/IoTBindingConfigModal.tsx` | 整文件：选择 MQTT 连接（sourceId）、协议、数据类型、source/target 规则 |
| 实例管理、选中实例 | `web/src/components/scenes/SceneSidebar.tsx`、`InstanceTree.tsx` | 选中实例后可在属性里打开 IoT 绑定 |

学习顺序：先看 `IoTBindingConfigModal.tsx` 里如何组 `source`（数据源路径）、`target`（目标属性）、`sourceId`，以及提交时调用的 API（如 iotBindingApi 的 create/update）。

---

## 三、对应文档「运行时数据流」— 从消息到界面与数据库

按**数据流顺序**读下面几块代码，和文档 4.1 流程图一致。

### 3.1 绑定与连接配置的拉取（进入预览时）

| 步骤 | 文件 | 行号 | 逻辑摘要 |
|------|------|------|----------|
| 拉取场景下所有绑定 | `web/src/hooks/usePreviewMode.ts` | **359–380** | `fetchSceneBindings`：调用 `iotBindingAPI.getSceneBindings(sceneId)`，得到绑定列表 |
| 拉取单个实例的绑定 | 同上 | **333–356** | `fetchIoTBindings`：`iotBindingAPI.getInstanceBindings(sceneId, instanceId)` |
| 按 sourceId 拉取 MQTT 等配置 | 同上 | **384–419** | `fetchConnectionConfigs`：根据 protocol 调 `mqttAPI.getMQTTById(sourceId)` 等，放入 Map |

### 3.2 连接池：按 sourceId 分组、建连接、订阅主题

| 步骤 | 文件 | 行号 | 逻辑摘要 |
|------|------|------|----------|
| 按 sourceId 分组绑定 | `web/src/hooks/usePreviewMode.ts` | **434–505** | `buildConnectionPool`：`bindingGroups` 按 sourceId 分组，为每个 sourceId 建/更新一个 `IoTConnection` |
| 启动连接池 | 同上 | **510–524** | `startConnectionPool`：对每个 connection 调用 `connectToPool` |
| MQTT 连接与订阅 | 同上 | **641–866** | `connectMQTTToPool`：mqtt.connect → 在 `connect` 里从绑定规则用 **parseSourcePath** 取出 topic，订阅 → **client.on('message')** 里调 **handlePoolData** |

重点看 **837–866 行**：`client.on('message', (topic, payload, packet) => { ... handlePoolData(sourceId, message, topic); })`，这是「MQTT 消息进入系统」的入口。

### 3.3 消息处理：handlePoolData → 规则解析 → 取值 → 回调

| 步骤 | 文件 | 行号 | 逻辑摘要 |
|------|------|------|----------|
| 收到消息后的统一入口 | `web/src/hooks/usePreviewMode.ts` | **668–635** | `handlePoolData(sourceId, rawData, topic)`：找到该 sourceId 的 connection.bindings，对每条 binding 调 **processIoTDataAndUpdateInstance** |
| 单条绑定的处理 | 同上 | **102–237** | `processIoTDataAndUpdateInstance`：<br>1️⃣ **IoTDataProcessor.processData(rawData, dataType)** 解析为 JSON 等<br>2️⃣ 对每条 **bindingRule**：**parseSourcePath(rule.source, topic, ...)** 得到 topicPath、dataPath，做 topic 匹配<br>3️⃣ **DataBindingProcessor.extractValue(data, dataPath)** 取值<br>4️⃣ **callbacksRef.current.onInstanceUpdate(instanceId, rule.target, value)** 回调 |
| 数据源路径解析 | 同上 | **243–312** | **parseSourcePath**：MQTT+JSON 时，无 `/` 则「第一个点前=主题，第一个点后=JSON 路径」（如 `sensor.scale` → topicPath=`sensor`，dataPath=`scale`） |
| 从 JSON 按路径取值 | `web/src/utils/iotDataProcessor.ts` | **406–437** | **DataBindingProcessor.extractValue(data, path)**：支持 `a.b.c`、`arr[0]` 等，返回取值结果 |

学习顺序：先看 `handlePoolData`（668）→ `processIoTDataAndUpdateInstance`（102）→ `parseSourcePath`（243）→ `iotDataProcessor.ts` 的 `extractValue`（406）。

### 3.4 场景编辑器：onInstanceUpdate → 更新 Cesium → 持久化

| 步骤 | 文件 | 行号 | 逻辑摘要 |
|------|------|------|----------|
| 预览时传入的回调 | `web/src/pages/Scenes/SceneEditorStandalone.tsx` | **486–534** | **onInstanceUpdate(instanceId, property, value)**：根据 instanceId 从 primitive 缓存取 Cesium 对象，节流（33ms）后调 **applyPropertyUpdate** |
| 按 target 更新 Cesium | 同上 | **657–884** | **applyPropertyUpdate(primitive, property, value, targetInstanceId)**：switch(property) 分支处理 `scale`、`rotation`、`location`、`visibility`、`material.xxx` 等，内部调 `updateModelScale`、`updateModelRotation`、`updateModelPosition*`、`primitive.show`、`updateModelMaterial` 等 |
| 持久化（节流 2 秒） | 同上 | **547–654** | **persistInstanceUpdate(instanceId, property, value)**：把更新放进 pendingPersistValues，2 秒内只执行最后一次；内部 **getInstanceProperties** 拉当前属性，按 property 合并进 transform 或 properties，再 **updateInstanceProperties** 写回 |
| 持久化在 apply 里触发 | 同上 | **884** | 在 `applyPropertyUpdate` 末尾调 **persistInstanceUpdate(targetInstanceId, property, value)** |

学习顺序：`onInstanceUpdate`（486）→ `applyPropertyUpdate`（657，可重点看 scale/rotation/location/visibility 几个 case）→ `persistInstanceUpdate`（547）。

### 3.5 后端 API：实例属性读/写

| 步骤 | 文件 | 行号/说明 |
|------|------|------------|
| 获取实例当前属性 | `web/src/services/sceneApi.ts` | **86–88**：`getInstanceProperties(instanceId)` → GET `/instances/:id/properties` |
| 更新实例属性 | 同上 | **91–93**：`updateInstanceProperties(instanceId, data)` → PUT `/instances/:id`，后端会合并进 Neo4j 的 Instance.transform / Instance.properties |

后端路由与 Neo4j 的读写一般在 `app/routers/scene.py` 或 `app/routers/instance.py`，可再按项目结构查 `instances/:id`、`properties` 对应实现。

---

## 四、文档「路径解析」「目标属性」「节流」在代码中的体现

| 文档小节 | 代码位置 |
|----------|----------|
| **4.2 路径解析（parseSourcePath）** | `usePreviewMode.ts` **243–312**（MQTT+JSON 第一个点前=主题，第一个点后=dataPath） |
| **4.3 目标属性与 transform/properties 对应** | `SceneEditorStandalone.tsx` **657–831**（applyPropertyUpdate 各 case）+ **577–619**（persistInstanceUpdate 里按 property 写 transform 或 properties） |
| **4.4 节流** | 渲染：**518–523**（33ms 间隔）；持久化：**547–654**（setTimeout 2000，pending 合并写） |

---

## 五、建议阅读顺序（按数据流一条线走通）

1. **数据模型**：`app/models/scene.py` 的 `Instance`（transform、properties、iot_binds）。
2. **配置从哪来**：`iotBindingApi.ts` 的 `getSceneBindings` / `getInstanceBindings`，`mqttApi.getMQTTById`；`usePreviewMode.ts` 的 `fetchSceneBindings`、`fetchConnectionConfigs`。
3. **连接池**：`usePreviewMode.ts` 的 `buildConnectionPool`、`connectMQTTToPool`，重点看 `client.on('message')` 调 `handlePoolData`。
4. **一条消息如何变成一次更新**：`handlePoolData` → `processIoTDataAndUpdateInstance` → `parseSourcePath`、`DataBindingProcessor.extractValue`、`onInstanceUpdate`。
5. **从回调到画面与数据库**：`SceneEditorStandalone.tsx` 的 `onInstanceUpdate` → `applyPropertyUpdate` → `persistInstanceUpdate`；`sceneApi` 的 `getInstanceProperties`、`updateInstanceProperties`。

按上述顺序读完后，再回头看《MQTT与3D场景联动机制说明》的流程图和示例，会更容易把「文档里的每一步」和「具体哪一行代码」对上。

---

## 六、文件路径速查

| 角色 | 路径 |
|------|------|
| 预览模式 Hook（连接池、消息处理、路径解析） | `web/src/hooks/usePreviewMode.ts` |
| IoT 数据解析与按路径取值 | `web/src/utils/iotDataProcessor.ts` |
| 场景编辑器（onInstanceUpdate、apply、持久化） | `web/src/pages/Scenes/SceneEditorStandalone.tsx` |
| 场景/实例 API（实例属性、绑定） | `web/src/services/sceneApi.ts`、`web/src/services/iotBindingApi.ts` |
| MQTT 配置 API | `web/src/services/mqttApi.ts` |
| 后端 Instance 模型 | `app/models/scene.py` |

文档中「五、关键代码位置」的表格与本节路线一致，可按文档章节 + 本路线行号交叉对照学习。
