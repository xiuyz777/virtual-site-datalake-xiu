# IoT 实时值写回 Neo4j 更新说明

本文档说明「预览模式下收到 MQTT/HTTP/WebSocket 数据后，将实例属性变更写回 Neo4j」的实现要点。

---

## 一、背景与目标

- **原状**：绑定配置存在 Neo4j（`Instance.iot_binds`），预览时前端按绑定规则更新 Cesium 场景，但**不会**把实时值持久化到 Neo4j。
- **目标**：在预览模式下，收到 IoT 消息并更新场景后，**按节流策略将变更写回 Neo4j**，支持同一实例多条绑定、多属性合并后一次 PUT。

---

## 二、实现概要

1. **新增工具**：`web/src/utils/iotInstanceSync.ts`，负责将 target 路径（如 `instance.instance.transform.location`）合并为 `PUT /instances/{id}` 的 payload。
2. **修改场景页**：`web/src/pages/Scenes/SceneEditorStandalone.tsx` 中持久化逻辑改为「按实例累积多条 target 变更，2 秒节流后合并写回」。

---

## 三、新增文件：`web/src/utils/iotInstanceSync.ts`

### 3.1 作用

- 将 **target 路径**（绑定里配置的 `instance.instance.xxx.yyy`）转换成实例更新对象上的嵌套字段。
- 支持多条路径与当前实例状态合并，得到完整的 `transform` / `properties` / `materials` 后再发 PUT。

### 3.2 导出函数

| 函数 | 说明 |
|------|------|
| `applyTargetPathToInstanceState(instanceState, targetPath, value)` | 把一条 target 路径应用到实例状态对象上（会修改 `instanceState`）。支持 `instance.instance.transform.*`、`instance.instance.properties.*`、`instance.instance.materials` 等。 |
| `buildInstanceUpdatePayloadFromPending(pending, currentInstance)` | 根据待写 Map（`targetPath -> value`）和当前实例状态，克隆并合并后返回 `{ transform?, properties?, materials? }`，用作 PUT 的 body。 |

### 3.3 target 路径约定

- `instance.instance.transform.location` → 写入 `state.transform.location`
- `instance.instance.transform.rotation` → 写入 `state.transform.rotation`
- `instance.instance.transform.scale` → 写入 `state.transform.scale`
- `instance.instance.properties.xxx` → 写入 `state.properties.xxx`
- `instance.instance.materials` 等同理；单层 `instance.transform.xxx` 也兼容。

---

## 四、修改文件：`SceneEditorStandalone.tsx`

### 4.1 待写数据结构

- **原逻辑**：`pendingPersistValues` 为 `Map<instanceId, { property, value }>`，同一实例只保留最后一次 `(property, value)`，写回时只持久化一条。
- **现逻辑**：`pendingPersistValues` 改为 `Map<instanceId, Record<targetPath, value>>`，同一实例在节流周期内的**所有** target 更新都会累积到该对象的多个 key 上。

### 4.2 持久化流程（节流 2 秒）

1. **收集**：每次 `onInstanceUpdate(instanceId, property, value)` 触发 `applyPropertyUpdate` 后调用 `persistInstanceUpdate(instanceId, property, value)`，将 `(property, value)` 写入 `pendingPersistValues.current.get(instanceId)[property] = value`（无则先初始化该实例的 `{}`）。
2. **定时器**：每个实例独立一个 2 秒定时器；若 2 秒内再次调用则清除旧定时器并重新计时。
3. **写回**：定时器到期后：
   - 取出该实例的 `pendingRecord = pendingPersistValues.current.get(instanceId)`；
   - 若为空则直接返回；
   - 调用 `getInstanceProperties(instanceId)` 得到当前实例（`response.data.data.instance`）；
   - 使用 `buildInstanceUpdatePayloadFromPending(pendingRecord, currentInstance)` 得到合并后的 `updateData`；
   - 若 `updateData` 非空则调用 `updateInstanceProperties(instanceId, updateData)`（即 `PUT /instances/{instanceId}`）；
   - 清理该实例的 `pendingPersistValues` 与定时器。

### 4.3 依赖与调用关系

- 引入：`import { buildInstanceUpdatePayloadFromPending } from '../../utils/iotInstanceSync';`
- 仍使用现有 `getInstanceProperties`、`updateInstanceProperties`（`sceneApi`），无后端接口变更。

---

## 五、数据流小结

```
MQTT/HTTP/WS 消息
  → usePreviewMode processIoTDataAndUpdateInstance
  → onInstanceUpdate(instanceId, targetPath, value)
  → applyPropertyUpdate（更新 Cesium）
  → persistInstanceUpdate(instanceId, targetPath, value)
  → 写入 pendingPersistValues[instanceId][targetPath] = value，重置 2s 定时器
  → 2 秒后：取 pending、拉当前实例、buildInstanceUpdatePayloadFromPending → PUT /instances/{id}
  → Neo4j 中该实例的 transform/properties/materials 更新
```

---

## 六、注意事项

- **节流**：每个实例 2 秒内多次更新只触发一次 PUT，减少请求量。
- **合并**：同一实例的多条绑定、多个 target 会在一次请求中合并写回，不会互相覆盖。
- **当前状态**：写回前会先拉取当前实例，再在内存中合并 pending 路径后发送，避免只传部分字段导致后端覆盖掉未更新的字段。
- **场景级绑定**：`instanceId === 'scene'` 时不调用持久化，仅更新画面。

---

## 七、涉及文件列表

| 文件 | 变更类型 |
|------|----------|
| `web/src/utils/iotInstanceSync.ts` | 新增 |
| `web/src/pages/Scenes/SceneEditorStandalone.tsx` | 修改（持久化逻辑 + 引入 iotInstanceSync） |

后端与现有绑定配置、`Instance.iot_binds` 存储方式均无改动。
