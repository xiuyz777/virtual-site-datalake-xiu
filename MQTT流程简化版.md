# MQTT 订阅到持久化 - 简化流程说明

## 🎯 核心流程（5个阶段）

```
MQTT消息 → 解析提取 → 更新模型 → 持久化 → 数据库
```

---

## 📊 详细步骤

### 阶段1: MQTT 订阅与接收
**文件**: `usePreviewMode.ts`

1. **连接池构建** (`buildConnectionPool`)
   - 按 `sourceId` 分组绑定
   - 同一 MQTT 配置的绑定共享一个连接

2. **MQTT 连接** (`connectMQTTToPool`)
   - 连接到 Broker（如 `broker.emqx.io:8083`）
   - 订阅所有绑定规则中的主题（如 `sensor`）

3. **消息接收**
   ```typescript
   client.on('message', async (topic, payload) => {
     await handlePoolData(sourceId, payload.toString(), topic);
   });
   ```

**关键变更**: 修复连接不存在时的处理（从状态中查找绑定）

---

### 阶段2: 消息解析与数据提取
**文件**: `usePreviewMode.ts` → `processIoTDataAndUpdateInstance`

**示例**: 
- 数据源路径: `"sensor.scale"`
- MQTT 消息: `{ "scale": [1, 3, 5] }`

**解析过程**:
1. `parseSourcePath("sensor.scale")` 
   - 输出: `topicPath = "sensor"`, `dataPath = "scale"`
2. `extractValue(data, "scale")`
   - 输出: `[1, 3, 5]`

**关键变更**: 修复 `sensor.scale` 的解析（第一个点前=主题，第一个点后=JSON路径）

---

### 阶段3: 模型属性更新
**文件**: `SceneEditorStandalone.tsx` → `applyPropertyUpdate`

**流程**:
1. `onInstanceUpdate(instanceId, "scale", [1,3,5])` 被调用
2. 查找 Cesium primitive（通过 `primitiveCache`）
3. 节流检查（33ms间隔，30fps）
4. `applyPropertyUpdate` 根据属性类型更新：
   - `scale` → `updateModelScale(primitive, [1,3,5])`
   - `rotation` → `updateModelRotation(...)`
   - `location` → `updateModelPosition(...)`

**关键变更**: 添加对完整路径的支持（`instance.instance.transform.scale`）

---

### 阶段4: 持久化（节流写库）
**文件**: `SceneEditorStandalone.tsx` → `persistInstanceUpdate`

**节流机制**:
```
更新1 → 存储到 pending → 设置定时器（2秒）
更新2 → 清除旧定时器 → 设置新定时器（2秒）
更新3 → 清除旧定时器 → 设置新定时器（2秒）
...
2秒后 → 执行写库（只写最后一次的值）
```

**写库逻辑**:
1. 从 `pendingPersistValues` 获取最新值
2. 从数据库获取当前属性
3. 合并更新（避免覆盖其他字段）
4. 调用 API 写入数据库

**关键变更**: 
- 修复闭包问题（使用 `pending` 中的最新值）
- 支持所有属性路径格式

---

### 阶段5: 数据库保存
**文件**: `sceneApi.ts` → `updateInstanceProperties`

**数据库结构** (Neo4j):
```cypher
(:Instance {
  transform: {
    scale: [1, 3, 5],
    rotation: [0, 0, 0],
    location: [0, 0, 0]
  },
  properties: {
    visibility: true,
    material: {...}
  }
})
```

---

## 🔑 6个关键变更点

| 变更点 | 文件 | 行数 | 问题 | 修复 |
|--------|------|------|------|------|
| 1. 路径解析 | `usePreviewMode.ts` | 279-281 | `sensor.scale` 解析错误 | 正确提取主题和路径 |
| 2. 连接池同步 | `usePreviewMode.ts` | 658-707 | 连接不存在时无法处理 | 从状态中查找绑定 |
| 3. 场景切换 | `usePreviewMode.ts` | 1228-1238 | 切换场景时绑定未重载 | 添加 sceneId 依赖 |
| 4. 属性路径 | `SceneEditorStandalone.tsx` | 710-722 | 不支持完整路径 | 添加所有路径格式 |
| 5. 闭包问题 | `SceneEditorStandalone.tsx` | 568-570 | 只保存第一次值 | 使用最新值 |
| 6. 持久化映射 | `SceneEditorStandalone.tsx` | 581-601 | 路径映射不完整 | 支持所有格式 |

---

## 💡 核心设计思路

### 1. **连接池设计**
- 同一 MQTT 配置的绑定共享连接
- 减少连接数，提高性能

### 2. **双重节流**
- **渲染节流**: 33ms（30fps）→ 避免 UI 卡顿
- **持久化节流**: 2秒 → 避免频繁写库

### 3. **数据合并**
- 先读后写，避免覆盖
- 保证数据完整性

### 4. **路径灵活性**
- 支持简单/中等/完整路径格式
- 兼容不同配置习惯

---

## 📝 完整示例

**输入**:
```
MQTT Topic: sensor
MQTT Payload: { "scale": [1, 3, 5] }
绑定配置: 数据源="sensor.scale", 目标="instance.instance.transform.scale"
```

**处理流程**:
1. ✅ 订阅 `sensor` 主题
2. ✅ 接收消息 `{ "scale": [1, 3, 5] }`
3. ✅ 解析: `topicPath="sensor"`, `dataPath="scale"`
4. ✅ 提取: `[1, 3, 5]`
5. ✅ 更新模型: `updateModelScale(primitive, [1,3,5])`
6. ✅ 2秒后持久化: `transform.scale = [1, 3, 5]`

**输出**:
- 模型立即显示更新
- 数据库保存最新值
- 刷新页面后保持状态

---

## ✅ 验证清单

- [ ] MQTT 连接成功（查看日志 `MQTT连接成功`）
- [ ] 消息接收（查看日志 `收到消息`）
- [ ] 数据提取（查看日志 `最终提取结果`）
- [ ] 模型更新（查看日志 `已更新模型缩放`）
- [ ] 持久化成功（查看日志 `✅ 持久化成功`）
- [ ] 数据库验证（查询 Neo4j `transform.scale`）

---

**快速参考**: 详细说明请查看 `MQTT到持久化完整流程说明.md`
