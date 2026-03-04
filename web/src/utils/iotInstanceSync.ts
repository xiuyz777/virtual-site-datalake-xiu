// up by xiu: IoT 实例属性实时值写回 Neo4j 的辅助工具
/**
 * IoT 绑定实时值同步到 Neo4j 实例属性的工具
 * 将 target 路径（如 instance.instance.transform.location）合并为 PUT /instances 的 payload
 */

/**
 * 在对象上按路径设置值（支持嵌套）
 */
function setNested(obj: Record<string, any>, path: string[], value: any): void {
  let current: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
}

/**
 * 将一条 target 路径应用到实例状态对象上（会修改 instanceState）
 * target 格式：instance.instance.transform.location | instance.instance.properties.temperature | instance.instance.materials 等
 */
export function applyTargetPathToInstanceState(
  instanceState: Record<string, any>,
  targetPath: string,
  value: any
): void {
  const parts = targetPath.split('.').filter(Boolean);
  if (parts.length < 3) return;

  // instance.instance.xxx.yyy...
  if (parts[0] === 'instance' && parts[1] === 'instance') {
    const root = parts[2]; // transform | properties | materials
    const rest = parts.slice(3);
    if (!rest.length) return;

    if (!instanceState[root] || typeof instanceState[root] !== 'object') {
      instanceState[root] = {};
    }
    setNested(instanceState[root], rest, value);
    return;
  }

  // instance.transform.xxx（兼容单层 instance 前缀）
  if (parts[0] === 'instance' && (parts[1] === 'transform' || parts[1] === 'properties' || parts[1] === 'materials')) {
    const root = parts[1];
    const rest = parts.slice(2);
    if (!instanceState[root] || typeof instanceState[root] !== 'object') {
      instanceState[root] = {};
    }
    setNested(instanceState[root], rest, value);
  }
}

/**
 * 从待写 Map（targetPath -> value）和当前实例状态，构建 PUT /instances 的 payload
 * 会先克隆 currentInstance，再应用所有 pending 路径，返回 { transform?, properties?, materials? }
 */
export function buildInstanceUpdatePayloadFromPending(
  pending: Record<string, any>,
  currentInstance: Record<string, any> | undefined
): Record<string, any> {
  const state: Record<string, any> = currentInstance
    ? JSON.parse(JSON.stringify(currentInstance))
    : { transform: {}, properties: {}, materials: [] };

  for (const [targetPath, value] of Object.entries(pending)) {
    applyTargetPathToInstanceState(state, targetPath, value);
  }

  const payload: Record<string, any> = {};
  if (state.transform && Object.keys(state.transform).length > 0) payload.transform = state.transform;
  if (state.properties && Object.keys(state.properties).length > 0) payload.properties = state.properties;
  if (state.materials != null) payload.materials = state.materials;
  return payload;
}
