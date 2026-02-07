# MQTT 订阅消息到永久保存的完整闭环流程

## 📋 目录
1. [整体架构概览](#整体架构概览)
2. [详细流程说明](#详细流程说明)
3. [关键变更点](#关键变更点)
4. [数据流转图](#数据流转图)
5. [代码位置索引](#代码位置索引)

---

## 🏗️ 整体架构概览

```
MQTT Broker
    ↓ (发布消息)
usePreviewMode Hook (订阅 & 接收)
    ↓ (解析消息)
processIoTDataAndUpdateInstance (处理绑定规则)
    ↓ (提取数据)
DataBindingProcessor.extractValue (提取JSON路径值)
    ↓ (更新模型)
onInstanceUpdate → applyPropertyUpdate (更新Cesium模型)
    ↓ (持久化)
persistInstanceUpdate (节流写库)
    ↓ (保存)
Neo4j 数据库 (transform/properties)
```

---

## 📖 详细流程说明

### 阶段1: MQTT 消息订阅与接收

**位置**: `web/src/hooks/usePreviewMode.ts`

#### 1.1 连接池构建 (`buildConnectionPool`)
- **功能**: 按 `sourceId` 对 IoT 绑定进行分组
- **逻辑**: 
  - 遍历所有启用的绑定 (`binding.enabled === true`)
  - 按 `sourceId` 分组，同一个 MQTT 连接配置的所有绑定归为一组
  - 为每个 `sourceId` 创建或更新连接对象

#### 1.2 MQTT 连接 (`connectMQTTToPool`)
- **功能**: 连接到 MQTT Broker 并订阅主题
- **关键代码** (第712-832行):
  ```typescript
  // 创建 MQTT 客户端
  const client = mqtt.default.connect(brokerUrl, {
    clientId: uniqueClientId,
    username: config.username,
    password: config.password,
    keepalive: config.keep_alive || 60,
  });
  
  // 订阅所有绑定规则中的主题
  for (const binding of connection.bindings) {
    for (const rule of binding.bindings || []) {
      const { topicPath } = parseSourcePath(rule.source, undefined, 'mqtt', 'json');
      if (topicPath) {
        client.subscribe(topicPath, { qos: 0 });
      }
    }
  }
  ```

#### 1.3 消息接收 (`client.on('message')`)
- **功能**: 接收 MQTT 消息并转发到处理函数
- **关键代码** (第850-892行):
  ```typescript
  client.on('message', async (receivedTopic, payload) => {
    const message = payload.toString();
    await handlePoolData(sourceId, message, receivedTopic);
  });
  ```

**变更点1**: 修复连接不存在时的处理
- **问题**: 消息到达时连接可能已被清理
- **修复**: 在 `handlePoolData` 中，如果连接不存在，从 `iotBindings` 状态中查找绑定并处理

---

### 阶段2: 消息解析与数据提取

**位置**: `web/src/hooks/usePreviewMode.ts`

#### 2.1 路径解析 (`parseSourcePath`)
- **功能**: 解析数据源路径，提取 MQTT 主题和 JSON 路径
- **输入示例**: `"sensor.scale"`
- **输出**: 
  - `topicPath`: `"sensor"` (MQTT 主题)
  - `dataPath`: `"scale"` (JSON 对象中的路径)

**关键变更点2**: 修复 MQTT+JSON 无斜杠时的解析
- **问题**: `sensor.scale` 被错误解析为 `topicPath = ''`, `dataPath = 'sensor.scale'`
- **修复** (第279-281行):
  ```typescript
  // [修复] MQTT+JSON 无斜杠时：第一个点前=MQTT主题，第一个点后=JSON路径
  topicPath = sourcePath.substring(0, firstDotIndex);  // "sensor"
  dataPath = sourcePath.substring(firstDotIndex + 1);  // "scale"
  ```

#### 2.2 数据提取 (`DataBindingProcessor.extractValue`)
- **功能**: 从 JSON 对象中提取指定路径的值
- **输入**: 
  - `data`: `{ "scale": [1, 3, 5] }`
  - `dataPath`: `"scale"`
- **输出**: `[1, 3, 5]`

**位置**: `web/src/utils/iotDataProcessor.ts`

---

### 阶段3: 模型属性更新

**位置**: `web/src/pages/Scenes/SceneEditorStandalone.tsx`

#### 3.1 回调触发 (`onInstanceUpdate`)
- **功能**: 接收更新请求并调用 `applyPropertyUpdate`
- **关键代码** (第387-436行):
  ```typescript
  onInstanceUpdate: (instanceId, property, value) => {
    // 查找对应的 Cesium primitive
    const primitive = primitiveCache.current.get(instanceId);
    if (primitive) {
      // 节流：限制更新频率不超过30fps
      const now = Date.now();
      const lastUpdate = lastUpdateTime.current.get(instanceId) || 0;
      if (now - lastUpdate >= 33) {
        applyPropertyUpdate(primitive, property, value, instanceId);
        lastUpdateTime.current.set(instanceId, now);
      }
    }
  }
  ```

#### 3.2 属性应用 (`applyPropertyUpdate`)
- **功能**: 根据属性类型更新 Cesium 模型的显示
- **支持的属性类型**:
  - `scale` / `instance.transform.scale` / `instance.instance.transform.scale` → 调用 `updateModelScale`
  - `rotation` / `instance.transform.rotation` → 调用 `updateModelRotation`
  - `location` / `position` → 调用 `updateModelPositionAbsolute`
  - `visibility` → 设置 `primitive.show = Boolean(value)`
  - `material.*` → 调用 `updateModelMaterial`

**关键变更点3**: 添加对完整路径的支持
- **问题**: 只支持简单属性名（如 `scale`），不支持完整路径（如 `instance.instance.transform.scale`）
- **修复** (第710-722行):
  ```typescript
  case 'scale':
  case 'instance.transform.scale':
  case 'instance.instance.transform.scale':
    updateModelScale(primitive, value, iotAnimationSettings.enableSmoothTransition);
    break;
  ```

---

### 阶段4: 持久化到数据库

**位置**: `web/src/pages/Scenes/SceneEditorStandalone.tsx`

#### 4.1 持久化函数 (`persistInstanceUpdate`)
- **功能**: 将模型属性更新保存到 Neo4j 数据库
- **节流机制**: 2秒内只写最后一次，避免频繁写库

**关键代码** (第547-640行):
```typescript
const persistInstanceUpdate = useCallback(async (instanceId: string, property: string, value: any) => {
  // 1. 存储待写的值（用于节流）
  pendingPersistValues.current.set(instanceId, { property, value });
  
  // 2. 清除之前的定时器
  const existingTimer = persistTimers.current.get(instanceId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  // 3. 设置新的定时器：2秒后执行写库
  const timer = setTimeout(async () => {
    const pending = pendingPersistValues.current.get(instanceId);
    const latestProperty = pending.property;  // 使用最新值
    const latestValue = pending.value;
    
    // 4. 获取当前实例属性
    const currentProps = await getInstanceProperties(instanceId);
    
    // 5. 根据属性类型构造更新数据
    let updateData = {};
    if (latestProperty === 'scale' || ...) {
      // 合并更新 transform
      const newTransform = { ...currentTransform, scale: latestValue };
      updateData.transform = newTransform;
    } else if (latestProperty === 'visibility') {
      // 更新 properties
      updateData.properties = { ...currentProperties, visibility: Boolean(latestValue) };
    }
    
    // 6. 执行更新
    await updateInstanceProperties(instanceId, updateData);
  }, 2000);
  
  persistTimers.current.set(instanceId, timer);
}, []);
```

**关键变更点4**: 修复闭包问题
- **问题**: 定时器回调中使用闭包中的旧值，导致多次更新时只保存第一次的值
- **修复** (第568-570行):
  ```typescript
  // 🔧 修复：使用 pending 中的最新值，而不是闭包中的旧值
  const latestProperty = pending.property;
  const latestValue = pending.value;
  ```

#### 4.2 属性类型映射
- **transform 相关**: `scale`, `rotation`, `location` → 更新 `Instance.transform`
- **properties 相关**: `visibility`, `material.*` → 更新 `Instance.properties`

**关键变更点5**: 支持所有属性路径格式
- **修复** (第581-601行):
  ```typescript
  if (latestProperty === 'scale' || 
      latestProperty === 'instance.transform.scale' || 
      latestProperty === 'instance.instance.transform.scale') {
    newTransform.scale = latestValue;
  }
  ```

---

## 🔑 关键变更点总结

### 变更点1: MQTT 消息路径解析修复
**文件**: `web/src/hooks/usePreviewMode.ts` (第279-281行)
**问题**: `sensor.scale` 被错误解析
**修复**: 正确提取 `topicPath = "sensor"`, `dataPath = "scale"`

### 变更点2: 连接池状态同步
**文件**: `web/src/hooks/usePreviewMode.ts` (第658-707行)
**问题**: 消息到达时连接可能已被清理
**修复**: 连接不存在时从 `iotBindings` 状态中查找绑定

### 变更点3: 场景切换时重新加载绑定
**文件**: `web/src/hooks/usePreviewMode.ts` (第1228-1238行)
**问题**: 切换场景时 IoT 绑定未重新加载
**修复**: 添加 `sceneId` 和 `instanceId` 依赖，场景变化时重新启动预览模式

### 变更点4: 属性路径支持
**文件**: `web/src/pages/Scenes/SceneEditorStandalone.tsx` (第710-722行)
**问题**: 不支持完整路径（如 `instance.instance.transform.scale`）
**修复**: 添加对完整路径的 case 支持

### 变更点5: 持久化闭包问题
**文件**: `web/src/pages/Scenes/SceneEditorStandalone.tsx` (第568-570行)
**问题**: 定时器回调中使用闭包旧值
**修复**: 从 `pendingPersistValues` 中读取最新值

### 变更点6: 持久化属性路径映射
**文件**: `web/src/pages/Scenes/SceneEditorStandalone.tsx` (第581-601行)
**问题**: 持久化时不支持完整路径
**修复**: 添加对所有路径格式的支持

---

## 🔄 数据流转图

```
┌─────────────────────────────────────────────────────────────┐
│ 1. MQTT Broker 发布消息                                      │
│    Topic: "sensor"                                           │
│    Payload: { "scale": [1, 3, 5] }                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. usePreviewMode.connectMQTTToPool                         │
│    - 订阅主题 "sensor"                                       │
│    - 接收消息并调用 handlePoolData                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. handlePoolData                                           │
│    - 从连接池获取绑定列表                                    │
│    - 遍历所有绑定规则                                        │
│    - 调用 processIoTDataAndUpdateInstance                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. processIoTDataAndUpdateInstance                          │
│    - 解析数据源路径: "sensor.scale"                          │
│      → topicPath: "sensor"                                  │
│      → dataPath: "scale"                                    │
│    - 提取值: extractValue(data, "scale") → [1, 3, 5]        │
│    - 调用 onInstanceUpdate(instanceId, "scale", [1,3,5])   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. onInstanceUpdate (SceneEditorStandalone)                 │
│    - 查找 Cesium primitive                                  │
│    - 节流检查（33ms间隔）                                    │
│    - 调用 applyPropertyUpdate                               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. applyPropertyUpdate                                      │
│    - switch (property)                                      │
│    - case "scale": updateModelScale(primitive, [1,3,5])    │
│    - 更新 Cesium 模型显示                                    │
│    - 调用 persistInstanceUpdate (持久化)                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. persistInstanceUpdate                                    │
│    - 存储待写值到 pendingPersistValues                      │
│    - 清除旧定时器                                            │
│    - 设置新定时器（2秒后执行）                               │
│    - 2秒后：                                                 │
│      • 获取最新值（从 pendingPersistValues）                 │
│      • 获取当前实例属性（从数据库）                          │
│      • 合并更新 transform.scale = [1,3,5]                   │
│      • 调用 updateInstanceProperties                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Neo4j 数据库更新                                          │
│    MATCH (i:Instance {uid: instanceId})                    │
│    SET i.transform.scale = [1, 3, 5]                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 📍 代码位置索引

### 核心文件

1. **MQTT 连接与消息处理**
   - `web/src/hooks/usePreviewMode.ts`
     - `buildConnectionPool` (第434-505行): 构建连接池
     - `connectMQTTToPool` (第712-932行): MQTT 连接
     - `handlePoolData` (第658-707行): 处理接收到的数据
     - `parseSourcePath` (第243-327行): 解析数据源路径

2. **数据处理**
   - `web/src/utils/iotDataProcessor.ts`
     - `DataBindingProcessor.extractValue`: 提取 JSON 路径值

3. **模型更新**
   - `web/src/pages/Scenes/SceneEditorStandalone.tsx`
     - `onInstanceUpdate` (第387-436行): 接收更新回调
     - `applyPropertyUpdate` (第655-868行): 应用属性更新
     - `updateModelScale` (第1419-1477行): 更新模型缩放

4. **持久化**
   - `web/src/pages/Scenes/SceneEditorStandalone.tsx`
     - `persistInstanceUpdate` (第547-640行): 持久化函数
   - `web/src/services/sceneApi.ts`
     - `updateInstanceProperties`: API 调用
     - `getInstanceProperties`: 获取实例属性

5. **数据库模型**
   - `app/models/scene.py`
     - `Instance` 类 (第88-115行): 定义 transform 和 properties

---

## 💡 设计思路总结

### 1. **连接池设计**
- **目的**: 避免为每个绑定创建独立的 MQTT 连接
- **实现**: 按 `sourceId` 分组，同一个 MQTT 配置的所有绑定共享一个连接
- **优势**: 减少连接数，提高性能

### 2. **节流机制（双重）**
- **渲染节流**: 33ms 间隔（30fps），避免 UI 卡顿
- **持久化节流**: 2秒间隔，避免频繁写库
- **优势**: 平衡实时性和性能

### 3. **数据合并更新**
- **目的**: 避免覆盖其他字段
- **实现**: 先读取当前属性，再合并新值
- **示例**: 
  ```typescript
  const currentTransform = currentProps.transform || {};
  const newTransform = { ...currentTransform, scale: latestValue };
  ```

### 4. **路径解析灵活性**
- **支持多种格式**:
  - 简单: `scale`
  - 中等: `instance.transform.scale`
  - 完整: `instance.instance.transform.scale`
- **优势**: 兼容不同的绑定配置方式

### 5. **错误处理与容错**
- **连接不存在**: 从状态中查找绑定
- **数据格式错误**: 使用默认值
- **属性路径不支持**: 输出警告日志

---

## 🎯 关键设计决策

1. **为什么使用节流？**
   - MQTT 消息可能高频到达（如传感器数据）
   - 直接写库会导致数据库压力过大
   - 2秒节流保证最终一致性，同时减少写库次数

2. **为什么先更新显示再持久化？**
   - 用户体验优先：立即看到变化
   - 持久化是后台操作，失败不影响显示
   - 通过节流保证最终一致性

3. **为什么支持多种路径格式？**
   - 兼容历史配置
   - 支持不同的配置习惯
   - 提供灵活性

4. **为什么使用连接池？**
   - MQTT Broker 通常限制连接数
   - 减少资源消耗
   - 统一管理连接生命周期

---

## 📝 使用示例

### 完整流程示例

1. **配置 IoT 绑定**
   - 数据源路径: `sensor.scale`
   - 目标属性: `instance.instance.transform.scale`
   - MQTT 配置: `broker.emqx.io:8083`

2. **发送 MQTT 消息**
   ```json
   Topic: sensor
   Payload: { "scale": [1, 3, 5] }
   ```

3. **系统处理流程**
   - 订阅 `sensor` 主题
   - 接收消息 `{ "scale": [1, 3, 5] }`
   - 解析路径: `topicPath = "sensor"`, `dataPath = "scale"`
   - 提取值: `[1, 3, 5]`
   - 更新模型: `updateModelScale(primitive, [1,3,5])`
   - 2秒后持久化: `transform.scale = [1, 3, 5]`

4. **数据库结果**
   ```cypher
   MATCH (i:Instance {uid: 'xxx'})
   RETURN i.transform.scale
   // 结果: [1, 3, 5]
   ```

---

## ✅ 验证方法

1. **查看控制台日志**
   - `🧪 [简化测试] 消息 #X`: 消息接收
   - `✅ 持久化成功`: 数据库更新成功
   - `🔍 数据库验证`: 验证更新结果

2. **检查数据库**
   ```cypher
   MATCH (i:Instance {uid: 'your-instance-id'})
   RETURN i.transform.scale, i.properties.visibility
   ```

3. **观察模型变化**
   - 模型应该立即更新显示
   - 刷新页面后应该保持更新后的状态

---

## 🔧 故障排查

### 问题1: 模型不更新
- 检查 MQTT 连接是否成功
- 检查绑定配置是否正确
- 检查 `parseSourcePath` 解析结果

### 问题2: 数据未持久化
- 检查 `pendingPersistValues` 是否有值
- 检查定时器是否执行
- 检查 API 调用是否成功

### 问题3: 模型不可见
- 检查 `transform.scale` 是否为 `[0,0,0]`
- 检查 `properties.visibility` 是否为 `false`
- 检查模型位置是否在视野内

---

**文档生成时间**: 2026-02-06
**最后更新**: 2026-02-06
**作者**: up by xiu
