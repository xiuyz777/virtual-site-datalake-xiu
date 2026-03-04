import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Button,
  Modal,
  Tree,
  Input,
  Space,
  Typography,
  Alert,
  Card,
  Row,
  Col,
  Tag,
  message,
  Spin,
  Divider
} from 'antd';
import {
  EyeOutlined,
  AimOutlined,
  ReloadOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';

// 扩展DataNode类型支持自定义data属性
interface ExtendedDataNode extends DataNode {
  data?: {
    path: string;
    value: any;
    type: string;
  };
}

// up by xiu: 扩展数据预览能力（MQTT 收集 / HTTP 直连 / WebSocket 真实预览）
import { 
  IoTProtocolType
} from '../services/iotBindingApi';
import { mqttAPI } from '../services/mqttApi';
import { httpAPI } from '../services/httpApi';
import { websocketAPI } from '../services/websocketApi'; // up by xiu
import { getInstanceProperties } from '../services/sceneApi';
import { useMQTTConnection } from '../hooks/useMQTTConnection';
import { BoneNode, AnimationManagerState } from '../types/animation';
import { TargetType, iotBindingAPI } from '../services/iotBindingApi';

const { Text } = Typography;

// MaterialPreview组件：渲染材质预览
interface MaterialPreviewProps {
  selectedPath: string;
  materials: ExtendedDataNode[];
  viewerRef?: React.RefObject<any>;
}

const MaterialPreview: React.FC<MaterialPreviewProps> = ({ selectedPath, materials, viewerRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewImage, setPreviewImage] = useState<string>('');
  const [renderMethod, setRenderMethod] = useState<string>('canvas');

  // 从路径中解析材质ID和属性
  const parseMaterialPath = (path: string) => {
    const parts = path.split('.');
    if (parts.length >= 2 && parts[0] === 'material') {
      return {
        materialId: parts[1],
        property: parts.slice(2).join('.')
      };
    }
    return null;
  };

  // 获取当前选中的材质数据
  const getSelectedMaterial = () => {
    if (!selectedPath || materials.length === 0) return null;
    
    const pathInfo = parseMaterialPath(selectedPath);
    if (!pathInfo) return null;

    // 查找对应的材质
    for (const materialNode of materials) {
      const materialData = materialNode.data?.value;
      if (materialData && materialData.id === `material_${pathInfo.materialId}`) {
        return materialData;
      }
    }
    return null;
  };

  // 尝试从Cesium场景中渲染材质预览
  const renderMaterialFromCesiumScene = (material: any): Promise<string | null> => {
    return new Promise((resolve) => {
      try {
        const viewer = viewerRef?.current;
        if (!viewer) {
          resolve(null);
          return;
        }

        // 创建一个简单的球体几何体来显示材质
        const sphere = viewer.entities.add({
          position: window.Cesium.Cartesian3.fromDegrees(0, 0, 1000000), // 远离地球
          ellipsoid: {
            radii: new window.Cesium.Cartesian3(50000, 50000, 50000),
            material: window.Cesium.Color.WHITE
          }
        });

        // 尝试应用材质属性
        const properties = material.properties || {};
        
        if (properties.baseColorFactor) {
          const color = properties.baseColorFactor;
          if (Array.isArray(color) && color.length >= 3) {
            sphere.ellipsoid.material = new window.Cesium.Color(
              color[0], color[1], color[2], color[3] || 1.0
            );
          }
        }

        // 暂时渲染一帧
        viewer.camera.setView({
          destination: window.Cesium.Cartesian3.fromDegrees(0, 0, 200000),
          orientation: {
            heading: 0,
            pitch: -window.Cesium.Math.PI_OVER_TWO,
            roll: 0
          }
        });

        // 等待下一帧渲染完成
        viewer.scene.requestRender();
        
        setTimeout(() => {
          try {
            // 获取canvas内容
            const canvas = viewer.scene.canvas;
            const dataURL = canvas.toDataURL('image/png');
            
            // 清理临时实体
            viewer.entities.remove(sphere);
            
            resolve(dataURL);
          } catch (error) {
            console.error('从Cesium场景获取材质预览失败:', error);
            viewer.entities.remove(sphere);
            resolve(null);
          }
        }, 100);

      } catch (error) {
        console.error('Cesium材质渲染失败:', error);
        resolve(null);
      }
    });
  };

  // 渲染材质到Canvas（Canvas 2D方式）
  const renderMaterialToCanvas = (material: any) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置canvas尺寸
    canvas.width = 200;
    canvas.height = 120;

    // 清除画布
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 获取材质属性
    const properties = material.properties || {};
    const textures = material.textures || {};
    
    console.log('🎨 材质渲染 - 材质信息:', material);
    console.log('🖼️ 纹理信息:', textures);
    
    // 首先尝试渲染基础颜色纹理
    const baseColorTexture = textures.baseColorTexture;
    if (baseColorTexture) {
      console.log('🔍 检查基础颜色纹理:', baseColorTexture);
      
      let textureUrl = null;
      
      // 尝试多种方式获取纹理URL
      if (baseColorTexture.url) {
        textureUrl = baseColorTexture.url;
        console.log('✅ 从url属性获取纹理:', textureUrl);
      } else if (baseColorTexture.canvas) {
        // 如果有canvas，直接使用canvas数据
        console.log('✅ 使用canvas纹理');
        try {
          ctx.drawImage(baseColorTexture.canvas, 0, 0, canvas.width, canvas.height);
          
          // 应用颜色因子
          if (properties.baseColorFactor) {
            const color = properties.baseColorFactor;
            if (Array.isArray(color) && color.length >= 3) {
              ctx.globalCompositeOperation = 'multiply';
              ctx.fillStyle = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3] || 1.0})`;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.globalCompositeOperation = 'source-over';
            }
          }
          
          addMaterialText(ctx, material, canvas);
          const dataURL = canvas.toDataURL('image/png');
          setPreviewImage(dataURL);
          return;
        } catch (error) {
          console.warn('Canvas纹理渲染失败:', error);
        }
      } else if (baseColorTexture.type === 'webgl' && baseColorTexture.webglTexture) {
        console.log('⚠️ 检测到WebGL纹理，需要特殊处理');
        // WebGL纹理需要特殊处理，暂时显示占位符
        renderWebGLTexturePlaceholder(ctx, material, canvas);
        return;
      }
      
      // 如果有URL，尝试加载图像
      if (textureUrl) {
        const img = new Image();
        img.onload = () => {
          console.log('✅ 纹理图像加载成功');
          // 绘制纹理作为背景
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          
          // 应用颜色因子作为叠加
          if (properties.baseColorFactor) {
            const color = properties.baseColorFactor;
            if (Array.isArray(color) && color.length >= 3) {
              ctx.globalCompositeOperation = 'multiply';
              ctx.fillStyle = `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3] || 1.0})`;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.globalCompositeOperation = 'source-over';
            }
          }
          
          // 添加材质名称
          addMaterialText(ctx, material, canvas);
          
          // 转换为图片
          const dataURL = canvas.toDataURL('image/png');
          setPreviewImage(dataURL);
        };
        img.onerror = (error) => {
          console.warn('纹理加载失败:', error, 'URL:', textureUrl);
          renderWithColor(ctx, material, canvas);
        };
        
        // 设置crossOrigin以处理跨域纹理
        img.crossOrigin = 'anonymous';
        img.src = textureUrl;
        return;
      } else {
        console.log('⚠️ 纹理对象存在但无法获取URL，纹理属性:', Object.keys(baseColorTexture));
      }
    }
    
    // 如果没有纹理或纹理加载失败，使用颜色渲染
    console.log('📝 使用颜色渲染（无纹理或纹理加载失败）');
    renderWithColor(ctx, material, canvas);
  };

  // 渲染WebGL纹理占位符
  const renderWebGLTexturePlaceholder = (ctx: CanvasRenderingContext2D, material: any, canvas: HTMLCanvasElement) => {
    const properties = material.properties || {};
    
    // 使用渐变背景表示WebGL纹理
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#4a90e2');
    gradient.addColorStop(0.5, '#7ed321');
    gradient.addColorStop(1, '#f5a623');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 添加WebGL纹理标识
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    
    const text = 'WebGL Texture';
    const y = canvas.height / 2 - 10;
    ctx.strokeText(text, canvas.width / 2, y);
    ctx.fillText(text, canvas.width / 2, y);
    
    // 添加材质名称
    addMaterialText(ctx, material, canvas);
    
    // 转换为图片
    const dataURL = canvas.toDataURL('image/png');
    setPreviewImage(dataURL);
  };

  // 使用颜色渲染材质
  const renderWithColor = (ctx: CanvasRenderingContext2D, material: any, canvas: HTMLCanvasElement) => {
    const properties = material.properties || {};
    
    // 渲染基础颜色
    let baseColor = '#888888';
    if (properties.baseColorFactor) {
      const color = properties.baseColorFactor;
      if (Array.isArray(color) && color.length >= 3) {
        baseColor = `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`;
      }
    }

    // 创建渐变效果模拟金属度和粗糙度
    const metallicFactor = properties.metallicFactor || 0;
    const roughnessFactor = properties.roughnessFactor || 1;

    // 根据金属度和粗糙度创建不同的视觉效果
    if (metallicFactor > 0.5) {
      // 金属材质 - 使用渐变模拟反射
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, baseColor);
      gradient.addColorStop(0.5, '#ffffff');
      gradient.addColorStop(1, baseColor);
      ctx.fillStyle = gradient;
    } else {
      // 非金属材质 - 使用纯色
      ctx.fillStyle = baseColor;
    }

    // 填充背景
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 添加粗糙度效果（噪点）
    if (roughnessFactor > 0.3) {
      ctx.globalAlpha = roughnessFactor * 0.3;
      for (let i = 0; i < 100; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const size = Math.random() * 2;
        ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
        ctx.fillRect(x, y, size, size);
      }
      ctx.globalAlpha = 1;
    }

    // 添加发光效果
    if (properties.emissiveFactor) {
      const emissive = properties.emissiveFactor;
      if (Array.isArray(emissive) && emissive.length >= 3) {
        const emissiveIntensity = Math.max(emissive[0], emissive[1], emissive[2]);
        if (emissiveIntensity > 0) {
          ctx.globalAlpha = emissiveIntensity;
          const emissiveColor = `rgb(${Math.round(emissive[0] * 255)}, ${Math.round(emissive[1] * 255)}, ${Math.round(emissive[2] * 255)})`;
          ctx.fillStyle = emissiveColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }
      }
    }

    // 添加材质名称
    addMaterialText(ctx, material, canvas);

    // 转换为图片
    const dataURL = canvas.toDataURL('image/png');
    setPreviewImage(dataURL);
  };

  // 添加材质文字信息
  const addMaterialText = (ctx: CanvasRenderingContext2D, material: any, canvas: HTMLCanvasElement) => {
    const properties = material.properties || {};
    const metallicFactor = properties.metallicFactor || 0;
    const roughnessFactor = properties.roughnessFactor || 1;

    // 添加材质名称文字
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeText(material.name || 'Material', canvas.width / 2, canvas.height / 2);
    ctx.fillText(material.name || 'Material', canvas.width / 2, canvas.height / 2);

    // 添加属性信息
    ctx.font = '10px Arial';
    ctx.fillStyle = '#ffffff';
    const infoY = canvas.height - 20;
    const hasTexture = material.textures && Object.keys(material.textures).length > 0;
    const info = hasTexture 
      ? `🖼️ Textured | M:${(metallicFactor * 100).toFixed(0)}% R:${(roughnessFactor * 100).toFixed(0)}%`
      : `M:${(metallicFactor * 100).toFixed(0)}% R:${(roughnessFactor * 100).toFixed(0)}%`;
    ctx.strokeText(info, canvas.width / 2, infoY);
    ctx.fillText(info, canvas.width / 2, infoY);
  };

  // 当选中路径或材质数据变化时更新预览
  useEffect(() => {
    const material = getSelectedMaterial();
    if (material) {
      // 尝试使用Cesium场景渲染，如果失败则使用Canvas 2D渲染
      const tryRenderMaterial = async () => {
        try {
          // 首先尝试从Cesium场景渲染
          if (viewerRef?.current && window.Cesium && renderMethod === 'cesium') {
            const cesiumImage = await renderMaterialFromCesiumScene(material);
            if (cesiumImage) {
              setPreviewImage(cesiumImage);
              return;
            }
          }
        } catch (error) {
          console.warn('Cesium渲染失败，使用Canvas 2D渲染:', error);
        }
        
        // 使用Canvas 2D渲染
        renderMaterialToCanvas(material);
      };
      
      tryRenderMaterial();
    } else {
      setPreviewImage('');
    }
  }, [selectedPath, materials, renderMethod]);

  const material = getSelectedMaterial();

  return (
    <div style={{ 
      width: '100%', 
      border: '1px solid #d9d9d9', 
      borderRadius: '6px',
      backgroundColor: '#f5f5f5'
    }}>
      {/* 渲染方法切换按钮 */}
      <div style={{ 
        padding: '8px',
        borderBottom: '1px solid #e6e6e6',
        display: 'flex',
        gap: '8px',
        justifyContent: 'center'
      }}>
        <Button 
          size="small" 
          type={renderMethod === 'canvas' ? 'primary' : 'default'}
          onClick={() => setRenderMethod('canvas')}
        >
          Canvas 2D
        </Button>
        <Button 
          size="small" 
          type={renderMethod === 'cesium' ? 'primary' : 'default'}
          onClick={() => setRenderMethod('cesium')}
          disabled={!viewerRef?.current || !window.Cesium}
        >
          Cesium 3D
        </Button>
      </div>
      
      {/* 预览内容区域 */}
      <div style={{ 
        height: '120px', 
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '8px',
        position: 'relative'
      }}>
        {material ? (
          <>
            {previewImage ? (
              <img 
                src={previewImage} 
                alt="Material Preview"
                style={{ 
                  maxWidth: '100%', 
                  maxHeight: '100%',
                  borderRadius: '4px'
                }}
              />
            ) : (
              <div style={{ 
                width: '60px', 
                height: '60px', 
                background: 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4)',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: '24px',
                fontWeight: 'bold'
              }}>
                M
              </div>
            )}
            {/* 隐藏的Canvas用于渲染 */}
            <canvas 
              ref={canvasRef} 
              style={{ display: 'none' }}
            />
          </>
        ) : (
          <>
            <div style={{ 
              width: '60px', 
              height: '60px', 
              background: '#ddd',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#666',
              fontSize: '24px',
              fontWeight: 'bold'
            }}>
              ?
            </div>
            <Text type="secondary" style={{ fontSize: '12px', textAlign: 'center' }}>
              {selectedPath ? `预览: ${selectedPath.split('.').pop()}` : '选择材质查看预览'}
            </Text>
          </>
        )}
      </div>
    </div>
  );
};

// 安全的对象序列化函数，避免循环引用
const safeStringify = (obj: any, maxDepth = 3, currentDepth = 0): string => {
  if (currentDepth >= maxDepth) return '[Max Depth Reached]';
  
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  
  if (Array.isArray(obj)) {
    if (obj.length > 10) return `[Array(${obj.length})]`;
    try {
      return `[${obj.slice(0, 10).map(item => safeStringify(item, maxDepth, currentDepth + 1)).join(', ')}]`;
    } catch {
      return `[Array(${obj.length})]`;
    }
  }
  
  if (typeof obj === 'object') {
    // 检查是否是 Cesium 对象或包含循环引用的对象
    if (obj.constructor && obj.constructor.name && 
        (obj.constructor.name.includes('Cesium') || 
         obj.constructor.name === 'Context' ||
         obj.constructor.name === 'ShaderCache' ||
         obj._context || obj._shaderCache)) {
      return `[${obj.constructor.name}]`;
    }
    
    try {
      const keys = Object.keys(obj).slice(0, 5); // 只显示前5个属性
      const pairs = keys.map(key => {
        try {
          const value = obj[key];
          return `${key}: ${safeStringify(value, maxDepth, currentDepth + 1)}`;
        } catch {
          return `${key}: [Error]`;
        }
      });
      const suffix = Object.keys(obj).length > 5 ? ', ...' : '';
      return `{${pairs.join(', ')}${suffix}}`;
    } catch {
      return '[Object]';
    }
  }
  
  return String(obj);
};

interface DataPathHelperProps {
  protocol: IoTProtocolType;
  connectionId: string;
  onSourcePathSelect: (path: string) => void;
  onTargetPathSelect: (path: string) => void;
  instanceId: string;
  sceneId: string;
  modelId?: string;
  viewerRef?: React.RefObject<any>;
  selectedModelId?: string | null;
  animationState?: AnimationManagerState;
}

interface DataPreviewModalProps {
  visible: boolean;
  protocol: IoTProtocolType;
  connectionId: string;
  onClose: () => void;
  onPathSelect: (path: string) => void;
}

interface PropertySelectorModalProps {
  visible: boolean;
  instanceId: string;
  onClose: () => void;
  onPathSelect: (path: string) => void;
  animationState?: AnimationManagerState;
  viewerRef?: React.RefObject<any>;
  selectedModelId?: string | null;
}

// 数据预览模态框
const DataPreviewModal: React.FC<DataPreviewModalProps> = ({
  visible,
  protocol,
  connectionId,
  onClose,
  onPathSelect
}) => {
  const [loading, setLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [mqttConfig, setMqttConfig] = useState<any>(null);
  const [collectedMessages, setCollectedMessages] = useState<any>({});
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const collectedMessagesRef = useRef<any>({}); // 用于稳定存储收集到的消息
  const mqttConnectionRef = useRef<any>(null); // 用于稳定存储MQTT连接对象

  // MQTT连接hook（仅当协议为MQTT且有配置时使用）
  const mqttConnection = useMQTTConnection(
    protocol === IoTProtocolType.MQTT && mqttConfig ? {
      hostname: mqttConfig.hostname,
      port: mqttConfig.port,
      websocket_path: mqttConfig.websocket_path,
      client_id: mqttConfig.client_id,
      username: mqttConfig.username,
      password: mqttConfig.password,
      use_tls: mqttConfig.use_tls,
      topics: [], // 禁用自动订阅，我们手动控制
      default_qos: mqttConfig.default_qos || 0,
      keep_alive: mqttConfig.keep_alive || 60,
      clean_session: mqttConfig.clean_session,
      connection_timeout: mqttConfig.connection_timeout || 10,
      max_retries: 2,
      retry_delay: 3
    } : {
      hostname: '',
      port: 1883,
      topics: []
    }
  );
  
  // 将mqttConnection存储在ref中，避免useEffect的依赖问题
  mqttConnectionRef.current = mqttConnection;

  // 构建数据树结构
  const buildDataTree = (data: any, prefix = '', parentKey = '0'): ExtendedDataNode[] => {
    if (!data || typeof data !== 'object') {
      return [];
    }

    return Object.keys(data).map((key, index) => {
      const nodeKey = `${parentKey}-${index}`;
      const currentPath = prefix ? `${prefix}.${key}` : key;
      const value = data[key];
      
      let title = (
        <span>
          <strong>{key}</strong>
          {typeof value !== 'object' && (
            <span style={{ marginLeft: 8, color: '#666' }}>
              : {typeof value === 'string' ? `"${value}"` : String(value)}
            </span>
          )}
          <Tag style={{ marginLeft: 8, fontSize: '12px' }}>
            {Array.isArray(value) ? 'array' : typeof value}
          </Tag>
        </span>
      );

      const node: ExtendedDataNode = {
        key: nodeKey,
        title,
        data: { path: currentPath, value, type: typeof value }
      };

      if (typeof value === 'object' && value !== null) {
        node.children = buildDataTree(value, currentPath, nodeKey);
      }

      return node;
    });
  };

  // 获取数据预览
  const fetchDataPreview = async () => {
    setLoading(true);
    
    // 对于MQTT协议，不重置已收集的消息和连接状态
    if (protocol !== IoTProtocolType.MQTT) {
      setCollectedMessages({});
      setConnectionStatus('');
    }
    
    try {
      let data: any = null;

      if (protocol === IoTProtocolType.HTTP) {
        // 先获取HTTP配置详情
        const configResponse = await httpAPI.getHTTPById(connectionId);
        const httpConfig = configResponse.data;
        
        // 直接使用fetch API来获取数据
        const response = await fetch(httpConfig.base_url, {
          method: httpConfig.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...httpConfig.headers
          }
        });
        
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            data = await response.json();
          } else {
            data = { text: await response.text() };
          }
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } else if (protocol === IoTProtocolType.MQTT) {
        console.log('📡 开始获取MQTT数据预览...');
        
        // 获取配置但不设置状态，避免触发useEffect重新执行
        let configForPreview = mqttConfig;
        if (!configForPreview) {
          const configResponse = await mqttAPI.getMQTTById(connectionId);
          configForPreview = configResponse.data;
          console.log('⚙️ MQTT配置已获取:', configForPreview);
          
          // 延迟设置配置，避免在数据收集期间触发useEffect
          setTimeout(() => {
            setMqttConfig(configForPreview);
          }, 100);
        }
        
        console.log('⏳ 等待8秒收集MQTT数据...');
        console.log('📊 当前已收集消息数量:', Object.keys(collectedMessages).length);
        
        // 保存当前的collectedMessages引用，避免闭包问题
        let finalMessages = collectedMessages;
        
        // 等待一段时间让MQTT连接建立并收集消息
        await new Promise<void>((resolve) => {
          // 每秒检查一次收集到的消息
          let checkCount = 0;
          const checkInterval = setInterval(() => {
            checkCount++;
            console.log(`⏱️ 第${checkCount}秒检查: 状态中${Object.keys(collectedMessages).length}条消息，ref中${Object.keys(collectedMessagesRef.current).length}条消息`);
            
            if (checkCount >= 8) {
              clearInterval(checkInterval);
              finalMessages = collectedMessagesRef.current;
              console.log('⏰ 等待时间结束，检查收集到的消息...');
              console.log('💾 最终收集到的消息:', finalMessages);
              resolve();
            }
          }, 1000);
        });
        
        // 使用ref中的数据而不是状态，避免闭包问题
        const currentMessages = collectedMessagesRef.current;
        const finalConfig = configForPreview;
        
        // 处理收集到的消息
        if (Object.keys(currentMessages).length > 0) {
          console.log('✅ 有收集到数据，生成数据结构...');
          data = {
            _config: {
              name: finalConfig.name,
              topics: finalConfig.topics,
              hostname: finalConfig.hostname,
              port: finalConfig.port,
              message: "已收集到实时数据"
            },
            ...currentMessages
          };
        } else {
          console.log('❌ 没有收集到数据，显示配置信息...');
          const connection = mqttConnectionRef.current;
          console.log('🔍 连接状态检查:', {
            isConnected: connection?.isConnected,
            isConnecting: connection?.isConnecting,
            subscribedTopics: connection?.subscribedTopics,
            totalMessages: connection?.messages.length,
            error: connection?.error
          });
          data = {
            _config: {
              name: finalConfig.name,
              topics: finalConfig.topics,
              hostname: finalConfig.hostname,
              port: finalConfig.port,
              message: "暂无实时数据，请确保MQTT broker正在运行且有数据发布到订阅主题",
              debug_info: {
                isConnected: connection?.isConnected,
                subscribedTopics: connection?.subscribedTopics,
                messageCount: connection?.messages.length,
                error: connection?.error
              }
            }
          };
        }
      } else if (protocol === IoTProtocolType.WEBSOCKET) {
        // up by xiu: WebSocket 真实连接预览：拉取配置后连接，收到第一条消息即作为预览数据
        const configRes = await websocketAPI.getWebSocketById(connectionId);
        const wsConfig = configRes.data as { url: string; protocols?: string[] };
        const url = wsConfig?.url;
        if (!url) {
          throw new Error('WebSocket 数据源未配置 URL');
        }
        data = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('获取数据超时（10秒内未收到消息，请确保服务端会主动推送或先运行测试发送脚本）'));
          }, 10000);
          const ws = new WebSocket(url, wsConfig.protocols);
          ws.onmessage = (event) => {
            clearTimeout(timeout);
            try {
              const raw = event.data;
              const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
              ws.close();
              resolve(parsed);
            } catch {
              ws.close();
              resolve({ _raw: String(event.data) });
            }
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            ws.close();
            reject(new Error('WebSocket 连接失败，请检查 URL 及测试服务是否已启动'));
          };
          ws.onclose = () => { clearTimeout(timeout); };
        });
      }

      setPreviewData(data);
      message.success('数据获取成功');
    } catch (error) {
      console.error('获取数据预览失败:', error);
      message.error('获取数据预览失败');
    } finally {
      setLoading(false);
    }
  };

  // 树节点选择
  const handleTreeSelect = (selectedKeys: React.Key[], info: any) => {
    if (selectedKeys.length > 0) {
      const nodeData = info.node.data;
      if (nodeData) {
        // 允许选择基本类型、数组，但不允许选择普通对象
        if (typeof nodeData.value !== 'object' || Array.isArray(nodeData.value)) {
          setSelectedPath(nodeData.path);
        }
      }
    }
  };

  // 树节点展开
  const handleTreeExpand = (expandedKeys: React.Key[]) => {
    setExpandedKeys(expandedKeys.map(key => String(key)));
  };

  // 确认选择路径
  const handleConfirmPath = () => {
    if (selectedPath) {
      onPathSelect(selectedPath);
      handleClose();
      message.success(`已选择路径: ${selectedPath}`);
    } else {
      message.warning('请选择一个数据路径');
    }
  };

  // 关闭模态框时清理连接
  const handleClose = () => {
    if (protocol === IoTProtocolType.MQTT) {
      setConnectionStatus('');
      setCollectedMessages({});
      collectedMessagesRef.current = {}; // 重置ref
    }
    onClose();
  };

  // 使用useCallback创建稳定的消息处理函数
  const handleMQTTMessages = useCallback(() => {
    const connection = mqttConnectionRef.current;
    if (!connection || protocol !== IoTProtocolType.MQTT) return;
    
    // 更新连接状态
    if (connection.isConnecting) {
      console.log('🔄 MQTT连接中...');
      setConnectionStatus('正在连接MQTT服务器...');
    } else if (connection.isConnected) {
      console.log('✅ MQTT已连接');
      console.log('📋 已订阅主题:', connection.subscribedTopics);
      console.log('📊 连接统计:', {
        isConnected: connection.isConnected,
        subscribedTopics: connection.subscribedTopics.length,
        totalMessages: connection.messages.length
      });
      
      // 根据订阅状态更新连接状态显示
      if (connection.subscribedTopics.length > 0) {
        setConnectionStatus(`已连接并订阅 ${connection.subscribedTopics.length} 个主题，正在等待数据...`);
      } else {
        setConnectionStatus('已连接，但未订阅任何主题');
      }
    } else if (connection.error) {
      console.error('❌ MQTT连接错误:', connection.error);
      setConnectionStatus(`连接错误: ${connection.error}`);
    }
    
    // 处理收到的消息
    if (connection.messages.length > 0) {
      console.log('📨 收到消息总数:', connection.messages.length);
      const newMessages: any = {};
      connection.messages.forEach((msg: any, index: number) => {
        console.log(`📨 消息 ${index + 1}:`, {
          topic: msg.topic,
          direction: msg.direction,
          payload: msg.payload,
          timestamp: msg.timestamp
        });
        
        if (msg.direction === 'received' && msg.topic !== 'system') {
          try {
            // 尝试解析JSON
            const parsedPayload = JSON.parse(msg.payload);
            newMessages[msg.topic] = parsedPayload;
            console.log('✅ JSON解析成功:', msg.topic, parsedPayload);
          } catch (error) {
            // 如果不是JSON，直接使用原始数据
            newMessages[msg.topic] = msg.payload;
            console.log('📝 使用原始数据:', msg.topic, msg.payload);
          }
        }
      });
      
      if (Object.keys(newMessages).length > 0) {
        console.log('💾 保存收集到的消息:', newMessages);
        // 使用ref存储消息，避免状态丢失
        collectedMessagesRef.current = { ...collectedMessagesRef.current, ...newMessages };
        setCollectedMessages(collectedMessagesRef.current);
      }
    }
  }, [protocol]);

  // 监听MQTT连接状态和消息
  useEffect(() => {
    if (protocol === IoTProtocolType.MQTT && mqttConfig) {
      handleMQTTMessages();
    }
  }, [protocol, mqttConfig, handleMQTTMessages, mqttConnection.isConnected, mqttConnection.isConnecting, mqttConnection.messages.length]);

  // 管理MQTT连接状态 - 减少依赖项，避免重复连接
  useEffect(() => {
    if (protocol === IoTProtocolType.MQTT && mqttConfig && visible) {
      const connection = mqttConnectionRef.current;
      console.log('🔧 MQTT配置:', {
        hostname: mqttConfig.hostname,
        port: mqttConfig.port,
        topics: mqttConfig.topics,
        websocket_path: mqttConfig.websocket_path,
        visible: visible
      });
      
      // 避免重复连接
      if (connection && !connection.isConnected && !connection.isConnecting) {
        console.log('🚀 开始MQTT连接...');
        connection.connect();
      }
    }
  }, [protocol, mqttConfig?.hostname, mqttConfig?.port, visible]);

  // 监听连接状态变化，连接成功后订阅主题 - 使用独立的useEffect
  useEffect(() => {
    if (protocol === IoTProtocolType.MQTT && mqttConfig && visible) {
      const connection = mqttConnectionRef.current;
      if (connection && connection.isConnected) {
        console.log('✅ MQTT连接已建立，开始订阅主题...');
        console.log('📋 准备订阅的主题:', mqttConfig.topics);
        console.log('🔍 当前已订阅主题:', connection.subscribedTopics);
        
        if (mqttConfig.topics && mqttConfig.topics.length > 0) {
          // 只有当主题未订阅时才订阅
          const unsubscribedTopics = mqttConfig.topics.filter((topic: string) => 
            !connection.subscribedTopics.includes(topic)
          );
          
          if (unsubscribedTopics.length > 0) {
            console.log('📝 订阅新主题:', unsubscribedTopics);
            // 清除之前的消息
            connection.clearMessages();
            
            // 订阅新的主题
            unsubscribedTopics.forEach((topic: string) => {
              console.log(`📝 订阅主题: ${topic}`);
              connection.subscribe(topic, mqttConfig.default_qos || 0);
            });
          } else {
            console.log('🔄 所有主题已订阅');
          }
        } else {
          console.log('⚠️ 没有配置要订阅的主题');
        }
      }
    }
  }, [protocol, mqttConfig?.topics, mqttConnection.isConnected, visible]);

  // 清理：模态框关闭时断开MQTT连接
  useEffect(() => {
    if (protocol === IoTProtocolType.MQTT && !visible) {
      const connection = mqttConnectionRef.current;
      if (connection && connection.isConnected) {
        console.log('🔌 模态框关闭，断开MQTT连接...');
        connection.disconnect();
      }
    }
  }, [protocol, visible]);

  // 清理：仅在组件卸载时断开MQTT连接
  useEffect(() => {
    return () => {
      const connection = mqttConnectionRef.current;
      if (protocol === IoTProtocolType.MQTT && connection && connection.isConnected) {
        connection.disconnect();
      }
    };
  }, [protocol]);

  useEffect(() => {
    if (visible) {
      setPreviewData(null);
      setSelectedPath('');
      setExpandedKeys([]);
      // 不要重置collectedMessages和connectionStatus，让它们保持当前状态
      fetchDataPreview();
    }
  }, [visible]);

  return (
    <Modal
      title={
        <Space>
          <EyeOutlined />
          数据预览 - {protocol.toUpperCase()}
        </Space>
      }
      open={visible}
      onCancel={handleClose}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={fetchDataPreview} loading={loading}>
          重新获取
        </Button>,
        protocol === IoTProtocolType.MQTT && mqttConnection && (
          <Button 
            key="disconnect" 
            danger 
            onClick={() => {
              const connection = mqttConnectionRef.current;
              if (connection) {
                connection.disconnect();
                setConnectionStatus('连接已断开');
              }
            }}
            disabled={!mqttConnection.isConnected}
          >
            断开连接
          </Button>
        ),
        <Button key="cancel" onClick={handleClose}>
          取消
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirmPath} disabled={!selectedPath}>
          选择此路径
        </Button>
      ].filter(Boolean)}
      width={700}
      destroyOnClose
      zIndex={1020}
    >
      <Row gutter={16}>
        <Col span={14}>
          <Card 
            title="数据结构" 
            size="small"
            extra={
              loading && <Spin size="small" />
            }
          >
            {/* MQTT连接状态显示 */}
            {protocol === IoTProtocolType.MQTT && connectionStatus && (
              <Alert
                type={
                  connectionStatus.includes('错误') ? 'error' : 
                  connectionStatus.includes('已连接') ? 'success' : 'info'
                }
                message={connectionStatus}
                style={{ marginBottom: 16 }}
                showIcon
              />
            )}
            
            {previewData ? (
              <Tree
                treeData={buildDataTree(previewData)}
                onSelect={handleTreeSelect}
                expandedKeys={expandedKeys}
                onExpand={handleTreeExpand}
                defaultExpandAll
                height={400}
                style={{ overflow: 'auto' }}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                {loading ? (
                  <Space direction="vertical" align="center">
                    <Spin size="large" />
                    <Text>正在获取数据...</Text>
                    {protocol === IoTProtocolType.MQTT && connectionStatus && (
                      <Text type="secondary">{connectionStatus}</Text>
                    )}
                  </Space>
                ) : '暂无数据'}
              </div>
            )}
          </Card>
        </Col>
        <Col span={10}>
          <Card title="路径选择" size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Text strong>选中的路径:</Text>
                <Input 
                  value={selectedPath} 
                  onChange={(e) => setSelectedPath(e.target.value)}
                  placeholder="点击左侧数据节点选择路径"
                  style={{ marginTop: 8 }}
                />
              </div>
              
              {selectedPath && (
                <Alert
                  type="success"
                  showIcon
                  message="路径有效"
                  description={`数据路径: ${selectedPath}`}
                />
              )}

              {/* MQTT消息统计 */}
              {protocol === IoTProtocolType.MQTT && (
                <Alert
                  type="info"
                  showIcon
                  message="MQTT调试信息"
                  description={
                    <div>
                      <Text><strong>连接状态:</strong> {mqttConnection.isConnected ? '✅ 已连接' : mqttConnection.isConnecting ? '🔄 连接中' : '❌ 未连接'}</Text>
                      <br />
                      <Text><strong>已收集消息:</strong> {Object.keys(collectedMessages).length} 条</Text>
                      <br />
                      <Text><strong>总消息数:</strong> {mqttConnection.messages.length} 条</Text>
                      {mqttConnection.subscribedTopics.length > 0 ? (
                        <>
                          <br />
                          <Text><strong>已订阅主题:</strong> {mqttConnection.subscribedTopics.join(', ')}</Text>
                        </>
                      ) : (
                        <>
                          <br />
                          <Text style={{ color: '#ff6b35' }}><strong>⚠️ 未订阅任何主题</strong></Text>
                        </>
                      )}
                      {mqttConnection.error && (
                        <>
                          <br />
                          <Text style={{ color: '#f5222d' }}><strong>错误:</strong> {mqttConnection.error}</Text>
                        </>
                      )}
                      {mqttConfig && (
                        <>
                          <br />
                          <Text><strong>配置的主题:</strong> {mqttConfig.topics?.join(', ') || '无'}</Text>
                        </>
                      )}
                    </div>
                  }
                  style={{ marginBottom: 16 }}
                />
              )}

              <Divider />
              
              <div>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  <InfoCircleOutlined style={{ marginRight: 4 }} />
                  点击左侧树形结构中的叶子节点来选择数据路径，或手动输入路径。
                  {protocol === IoTProtocolType.MQTT && (
                    <> 对于MQTT数据，系统会自动连接并订阅配置的主题来收集实时数据。</>
                  )}
                </Text>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </Modal>
  );
};

// 属性选择器模态框
const PropertySelectorModal: React.FC<PropertySelectorModalProps> = ({
  visible,
  instanceId,
  onClose,
  onPathSelect,
  animationState,
  viewerRef,
  selectedModelId
}) => {
  const [loading, setLoading] = useState(false);
  const [instanceProperties, setInstanceProperties] = useState<any>(null);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'properties' | 'nodes' | 'materials'>('properties');
  const [materialTreeData, setMaterialTreeData] = useState<ExtendedDataNode[]>([]);

  // 构建属性树结构（使用instance.{instance property}.{key}格式）
  const buildPropertyTree = (data: any, prefix = '', parentKey = '0', isRoot = false): ExtendedDataNode[] => {
    if (!data || typeof data !== 'object') {
      return [];
    }

    return Object.keys(data).map((key, index) => {
      const nodeKey = `${parentKey}-${index}`;
      // 在根级别使用instance前缀
      const currentPath = isRoot 
        ? iotBindingAPI.buildTargetPath(TargetType.INSTANCE, key)
        : (prefix ? `${prefix}.${key}` : key);
      const value = data[key];
      
      let title = (
        <span>
          <strong>{key}</strong>
          {typeof value !== 'object' && (
            <span style={{ marginLeft: 8, color: '#666' }}>
              : {typeof value === 'string' ? `"${value}"` : String(value)}
            </span>
          )}
          <Tag style={{ marginLeft: 8, fontSize: '12px' }}>
            {Array.isArray(value) ? 'array' : typeof value}
          </Tag>
        </span>
      );

      const node: ExtendedDataNode = {
        key: nodeKey,
        title,
        data: { path: currentPath, value, type: typeof value }
      };

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        node.children = buildPropertyTree(value, currentPath, nodeKey, false);
      }

      return node;
    });
  };

  // 构建节点树结构（使用node.{nodeId}.{property}格式）
  const buildNodeTree = (nodes: BoneNode[], parentKey = '0'): ExtendedDataNode[] => {
    return nodes.map((node, index) => {
      const nodeKey = `${parentKey}-${index}`;
      const nodeId = node.id.replace('node_', ''); // 去掉node_前缀
      
      const nodeTitle = (
        <span>
          <strong>{node.name}</strong>
          <Tag style={{ marginLeft: 8, fontSize: '12px', backgroundColor: '#e6f7ff', color: '#1890ff' }}>
            节点
          </Tag>
          <span style={{ marginLeft: 8, color: '#666', fontSize: '12px' }}>
            ID: {nodeId}
          </span>
        </span>
      );

      const nodeTreeNode: ExtendedDataNode = {
        key: nodeKey,
        title: nodeTitle,
        data: { 
          path: iotBindingAPI.buildTargetPath(TargetType.NODE, nodeId),
          value: node, 
          type: 'node'
        },
        children: [
          // 添加变换属性作为子节点
          {
            key: `${nodeKey}-translation`,
            title: (
              <span>
                <strong>translation</strong>
                <span style={{ marginLeft: 8, color: '#666' }}>
                  : [{node.translation?.join(', ')}]
                </span>
                <Tag style={{ marginLeft: 8, fontSize: '12px' }}>array</Tag>
              </span>
            ),
            data: { 
              path: iotBindingAPI.buildTargetPath(TargetType.NODE, nodeId, 'translation'),
              value: node.translation,
              type: 'array'
            }
          } as ExtendedDataNode,
          {
            key: `${nodeKey}-rotation`,
            title: (
              <span>
                <strong>rotation</strong>
                <span style={{ marginLeft: 8, color: '#666' }}>
                  : [{node.rotation?.join(', ')}]
                </span>
                <Tag style={{ marginLeft: 8, fontSize: '12px' }}>array</Tag>
              </span>
            ),
            data: { 
              path: iotBindingAPI.buildTargetPath(TargetType.NODE, nodeId, 'rotation'),
              value: node.rotation,
              type: 'array'
            }
          } as ExtendedDataNode,
          {
            key: `${nodeKey}-scale`,
            title: (
              <span>
                <strong>scale</strong>
                <span style={{ marginLeft: 8, color: '#666' }}>
                  : [{node.scale?.join(', ')}]
                </span>
                <Tag style={{ marginLeft: 8, fontSize: '12px' }}>array</Tag>
              </span>
            ),
            data: { 
              path: iotBindingAPI.buildTargetPath(TargetType.NODE, nodeId, 'scale'),
              value: node.scale,
              type: 'array'
            }
          } as ExtendedDataNode
        ]
      };

      // 递归处理子节点
      if (node.children && node.children.length > 0) {
        const childNodes = buildNodeTree(node.children, nodeKey);
        nodeTreeNode.children = [...(nodeTreeNode.children || []), ...childNodes];
      }

      return nodeTreeNode;
    });
  };

  // 获取实例属性
  const fetchInstanceProperties = async () => {
    setLoading(true);
    try {
      const response = await getInstanceProperties(instanceId);
      setInstanceProperties(response.data.data);
      message.success('属性获取成功');
    } catch (error) {
      console.error('获取实例属性失败:', error);
      message.error('获取实例属性失败');
    } finally {
      setLoading(false);
    }
  };

  // 刷新材质数据
  const refreshMaterials = () => {
    setLoading(true);
    try {
      const newMaterialTree = buildMaterialTree();
      setMaterialTreeData(newMaterialTree);
      message.success('材质数据刷新成功');
    } catch (error) {
      console.error('刷新材质数据失败:', error);
      message.error('刷新材质数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 树节点选择
  const handleTreeSelect = (selectedKeys: React.Key[], info: any) => {
    if (selectedKeys.length > 0) {
      const nodeData = info.node.data;
      if (nodeData) {
        setSelectedPath(nodeData.path);
      }
    }
  };

  // 树节点展开
  const handleTreeExpand = (expandedKeys: React.Key[]) => {
    setExpandedKeys(expandedKeys.map(key => String(key)));
  };

  // 确认选择路径
  const handleConfirmPath = () => {
    if (selectedPath) {
      onPathSelect(selectedPath);
      onClose();
      message.success(`已选择路径: ${selectedPath}`);
    } else {
      message.warning('请选择一个路径');
    }
  };

  useEffect(() => {
    if (visible) {
      setInstanceProperties(null);
      setSelectedPath('');
      setExpandedKeys([]);
      if (activeTab === 'properties') {
        fetchInstanceProperties();
      } else if (activeTab === 'materials') {
        // 初始化材质数据
        const initialMaterialTree = buildMaterialTree();
        setMaterialTreeData(initialMaterialTree);
      }
    }
  }, [visible, activeTab]);

  // 处理标签页切换
  const handleTabChange = (key: string) => {
    setActiveTab(key as 'properties' | 'nodes' | 'materials');
    setSelectedPath('');
    setExpandedKeys([]);
    
    if (key === 'properties' && !instanceProperties) {
      fetchInstanceProperties();
    } else if (key === 'materials') {
      const initialMaterialTree = buildMaterialTree();
      setMaterialTreeData(initialMaterialTree);
    }
  };

  // 获取可用的节点数据
  const getAvailableNodes = (): BoneNode[] => {
    console.log('🔍 DataPathHelper - 检查animationState:', {
      hasAnimationState: !!animationState,
      boneNodesLength: animationState?.boneNodes?.length || 0,
      selectedModelId: animationState?.selectedModelId,
      isLoading: animationState?.isLoading,
      animationStateKeys: animationState ? Object.keys(animationState) : 'undefined'
    });
    
    if (animationState && animationState.boneNodes.length > 0) {
      console.log('✅ 返回节点数据:', animationState.boneNodes.length, '个节点');
      console.log('📋 节点详情:', animationState.boneNodes.map(node => ({
        id: node.id,
        name: node.name,
        hasChildren: !!(node.children && node.children.length > 0)
      })));
      return animationState.boneNodes;
    }
    console.log('❌ 没有节点数据可用，原因分析:', {
      animationStateExists: !!animationState,
      boneNodesExists: !!animationState?.boneNodes,
      boneNodesIsArray: Array.isArray(animationState?.boneNodes),
      boneNodesLength: animationState?.boneNodes?.length || 0
    });
    return [];
  };

  // 从Cesium模型中获取材质信息
  const getMaterialsFromCesiumModel = (): any[] => {
    const materials: any[] = [];
    
    try {
      // 获取Cesium viewer和当前选中的模型
      const viewer = viewerRef?.current;
      if (!viewer) {
        console.log('🔍 未找到Cesium viewer');
        return materials;
      }

      // 查找当前选中的模型
      let targetModel: any = null;
      const primitives = viewer.scene.primitives;
      
      for (let i = 0; i < primitives.length; i++) {
        const primitive = primitives.get(i);
        // 检查模型类型和ID
        if (primitive && primitive.constructor.name === 'Model') {
          // 优先查找匹配selectedModelId的模型
          if (selectedModelId && primitive.id === selectedModelId) {
            targetModel = primitive;
            break;
          }
          // 或者使用第一个找到的模型
          if (!targetModel && primitive.ready) {
            targetModel = primitive;
          }
        }
      }

      if (!targetModel) {
        console.log('🔍 未找到可用的glTF模型');
        return materials;
      }

      console.log('🎯 找到目标模型:', targetModel);

      // 等待模型加载完成
      if (!targetModel.ready) {
        console.log('⏳ 模型尚未加载完成');
        return materials;
      }

      // 尝试通过多种方式访问材质和纹理数据
      let gltfMaterials: any[] = [];
      let gltfTextures: any[] = [];

      // 方法1: 尝试通过 _sceneGraph 访问（新版本API）
      if (targetModel._sceneGraph && targetModel._sceneGraph._components) {
        const components = targetModel._sceneGraph._components;
        console.log('📋 SceneGraph Components结构:', components);
        
        // 获取纹理数组
        if (components.textures) {
          gltfTextures = components.textures;
          console.log('🖼️ 找到纹理数据:', gltfTextures.length, '个纹理');
        }
        
        if (components.scene && components.scene.nodes) {
          console.log('🔍 检查场景节点材质...');
          // 遍历节点寻找材质
          const traverseNodes = (nodes: any[]) => {
            nodes.forEach((node: any) => {
              if (node.primitives) {
                node.primitives.forEach((primitive: any) => {
                  if (primitive.material && !gltfMaterials.includes(primitive.material)) {
                    gltfMaterials.push(primitive.material);
                  }
                });
              }
              if (node.children) {
                traverseNodes(node.children);
              }
            });
          };
          traverseNodes(components.scene.nodes);
        }

        // 如果有materials数组直接访问
        if (components.materials) {
          console.log('📋 直接从components.materials获取:', components.materials);
          gltfMaterials = [...gltfMaterials, ...components.materials];
        }
      }

      // 方法2: 尝试通过 _modelComponents 访问（兼容方式）
      if (gltfMaterials.length === 0 && targetModel._modelComponents) {
        console.log('📋 尝试从_modelComponents获取材质');
        const modelComponents = targetModel._modelComponents;
        if (modelComponents.materials) {
          gltfMaterials = modelComponents.materials;
        }
        if (modelComponents.textures) {
          gltfTextures = modelComponents.textures;
        }
      }

      // 方法3: 尝试通过 gltf 属性访问（最新版本可能没有）
      if (gltfMaterials.length === 0 && targetModel.gltf) {
        console.log('📋 尝试从gltf属性获取材质');
        if (targetModel.gltf.materials) {
          gltfMaterials = targetModel.gltf.materials;
        }
        if (targetModel.gltf.textures) {
          gltfTextures = targetModel.gltf.textures;
        }
      }

      if (!gltfMaterials || gltfMaterials.length === 0) {
        console.log('🔍 未找到材质数据，检查模型结构...');
        console.log('🔍 模型属性:', Object.keys(targetModel));
        if (targetModel._sceneGraph) {
          console.log('🔍 _sceneGraph属性:', Object.keys(targetModel._sceneGraph));
        }
        return materials;
      }

      console.log('🎨 找到材质数据:', gltfMaterials.length, '个材质');
      console.log('🖼️ 找到纹理数据:', gltfTextures.length, '个纹理');

      // 解析材质数据
      gltfMaterials.forEach((material: any, index: number) => {
        const materialInfo: any = {
          id: `material_${index}`,
          name: material.name || `Material_${index}`,
          properties: {},
          textures: {}
        };

        console.log(`🎨 处理材质 ${index}:`, material);

        // 提取PBR材质属性
        if (material.pbrMetallicRoughness) {
          const pbr = material.pbrMetallicRoughness;
          
          if (pbr.baseColorFactor) {
            materialInfo.properties.baseColorFactor = Array.isArray(pbr.baseColorFactor) 
              ? Array.from(pbr.baseColorFactor) 
              : [pbr.baseColorFactor.x, pbr.baseColorFactor.y, pbr.baseColorFactor.z, pbr.baseColorFactor.w];
          }
          
          if (pbr.metallicFactor !== undefined) {
            materialInfo.properties.metallicFactor = pbr.metallicFactor;
          }
          
          if (pbr.roughnessFactor !== undefined) {
            materialInfo.properties.roughnessFactor = pbr.roughnessFactor;
          }
          
          // 获取基础颜色纹理
          if (pbr.baseColorTexture) {
            const textureIndex = pbr.baseColorTexture.index;
            materialInfo.properties.baseColorTexture = {
              index: textureIndex,
              texCoord: pbr.baseColorTexture.texCoord || 0
            };
            
            // 尝试获取纹理的URL或数据
            if (gltfTextures && gltfTextures[textureIndex]) {
              const texture = gltfTextures[textureIndex];
              console.log(`🖼️ 基础颜色纹理 ${textureIndex}:`, texture);
              
              // 方法1: 如果纹理有图像来源
              if (texture.source) {
                console.log('🎯 纹理来源:', texture.source);
                
                // 如果有canvas
                if (texture.source.canvas) {
                  materialInfo.textures.baseColorTexture = {
                    canvas: texture.source.canvas,
                    url: texture.source.canvas.toDataURL(),
                    type: 'canvas'
                  };
                  console.log('✅ 从source.canvas获取纹理');
                }
                // 如果有图像元素
                else if (texture.source.image) {
                  const img = texture.source.image;
                  if (img.src) {
                    materialInfo.textures.baseColorTexture = {
                      url: img.src,
                      type: 'image'
                    };
                    console.log('✅ 从source.image.src获取纹理URL:', img.src);
                  } else if (img instanceof HTMLCanvasElement) {
                    materialInfo.textures.baseColorTexture = {
                      canvas: img,
                      url: img.toDataURL(),
                      type: 'canvas'
                    };
                    console.log('✅ 从source.image canvas获取纹理');
                  }
                }
                // 如果有URI或src属性直接在source上
                else if (texture.source.uri) {
                  materialInfo.textures.baseColorTexture = {
                    url: texture.source.uri,
                    type: 'uri'
                  };
                  console.log('✅ 从source.uri获取纹理URL:', texture.source.uri);
                }
              }
              
              // 方法2: 从Cesium纹理对象获取
              if (!materialInfo.textures.baseColorTexture && texture._cesiumTexture) {
                const cesiumTexture = texture._cesiumTexture;
                console.log('🖼️ Cesium纹理对象:', cesiumTexture);
                
                // 尝试获取纹理的像素数据
                if (cesiumTexture._source && cesiumTexture._source.canvas) {
                  materialInfo.textures.baseColorTexture = {
                    canvas: cesiumTexture._source.canvas,
                    url: cesiumTexture._source.canvas.toDataURL(),
                    type: 'cesium-canvas'
                  };
                  console.log('✅ 从cesiumTexture._source.canvas获取纹理');
                } else if (cesiumTexture._source && cesiumTexture._source.image) {
                  const img = cesiumTexture._source.image;
                  materialInfo.textures.baseColorTexture = {
                    url: img.src || (img instanceof HTMLCanvasElement ? img.toDataURL() : null),
                    type: 'cesium-image'
                  };
                  console.log('✅ 从cesiumTexture._source.image获取纹理');
                }
                // 尝试通过其他属性获取
                else if (cesiumTexture.source) {
                  console.log('🎯 检查cesiumTexture.source:', cesiumTexture.source);
                  if (cesiumTexture.source.image && cesiumTexture.source.image.src) {
                    materialInfo.textures.baseColorTexture = {
                      url: cesiumTexture.source.image.src,
                      type: 'cesium-source'
                    };
                    console.log('✅ 从cesiumTexture.source.image.src获取纹理URL:', cesiumTexture.source.image.src);
                  }
                }
              }
              
              // 方法3: WebGL纹理（最后尝试）
              if (!materialInfo.textures.baseColorTexture && (texture._webglTexture || texture.webglTexture)) {
                const webglTexture = texture._webglTexture || texture.webglTexture;
                console.log('🎯 WebGL纹理:', webglTexture);
                
                // 尝试从WebGL上下文读取纹理
                try {
                  const gl = viewer.scene.context._gl;
                  if (gl && webglTexture) {
                    // 创建临时canvas来渲染纹理
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = 256;
                    tempCanvas.height = 256;
                    const tempGl = tempCanvas.getContext('webgl');
                    
                    if (tempGl) {
                      // 这里可以添加WebGL纹理读取逻辑
                      // 由于复杂性，暂时标记为WebGL纹理
                      materialInfo.textures.baseColorTexture = {
                        type: 'webgl',
                        webglTexture: webglTexture,
                        note: '需要WebGL读取'
                      };
                    }
                  }
                } catch (error) {
                  console.warn('WebGL纹理读取失败:', error);
                }
              }
              
              // 方法4: 尝试从原始glTF数据中获取图像数据
              if (!materialInfo.textures.baseColorTexture) {
                console.log('🔍 尝试从原始纹理对象获取图像数据...');
                
                // 检查是否有图像数据的其他位置
                const checkImageSources = [
                  texture.image,
                  texture.sampler,
                  texture.extensions,
                  texture.extras
                ];
                
                for (const source of checkImageSources) {
                  if (source && typeof source === 'object') {
                    console.log('🔍 检查图像源:', source);
                    if (source.uri) {
                      materialInfo.textures.baseColorTexture = {
                        url: source.uri,
                        type: 'gltf-uri'
                      };
                      console.log('✅ 从图像源URI获取:', source.uri);
                      break;
                    }
                    if (source.bufferView !== undefined) {
                      // 这是一个二进制缓冲区引用，可能需要特殊处理
                      materialInfo.textures.baseColorTexture = {
                        type: 'buffer',
                        bufferView: source.bufferView,
                        note: '二进制纹理数据'
                      };
                      console.log('✅ 发现二进制纹理数据，bufferView:', source.bufferView);
                      break;
                    }
                  }
                }
              }
              
              // 如果都没有获取到，记录调试信息
              if (!materialInfo.textures.baseColorTexture) {
                console.log('🔍 纹理对象详细信息:', {
                  textureKeys: Object.keys(texture),
                  hasSource: !!texture.source,
                  hasCesiumTexture: !!texture._cesiumTexture,
                  hasWebglTexture: !!(texture._webglTexture || texture.webglTexture),
                  hasImage: !!texture.image,
                  hasSampler: !!texture.sampler
                });
                
                // 尝试直接使用对象的toString或其他属性
                const possibleUrls = [];
                Object.keys(texture).forEach(key => {
                  const value = texture[key];
                  if (typeof value === 'string' && (value.startsWith('http') || value.startsWith('data:') || value.startsWith('blob:'))) {
                    possibleUrls.push(value);
                  }
                });
                
                if (possibleUrls.length > 0) {
                  materialInfo.textures.baseColorTexture = {
                    url: possibleUrls[0],
                    type: 'detected-url'
                  };
                  console.log('✅ 检测到可能的URL:', possibleUrls[0]);
                } else {
                  materialInfo.textures.baseColorTexture = {
                    type: 'unknown',
                    debug: Object.keys(texture),
                    note: '无法获取纹理数据'
                  };
                  console.log('❌ 无法获取纹理数据');
                }
              }
            }
          }
          
          if (pbr.metallicRoughnessTexture) {
            materialInfo.properties.metallicRoughnessTexture = {
              index: pbr.metallicRoughnessTexture.index,
              texCoord: pbr.metallicRoughnessTexture.texCoord || 0
            };
          }
        }

        // 提取其他材质属性
        if (material.emissiveFactor) {
          materialInfo.properties.emissiveFactor = Array.isArray(material.emissiveFactor)
            ? Array.from(material.emissiveFactor)
            : [material.emissiveFactor.x, material.emissiveFactor.y, material.emissiveFactor.z];
        }
        
        if (material.normalTexture) {
          materialInfo.properties.normalTexture = {
            index: material.normalTexture.index,
            texCoord: material.normalTexture.texCoord || 0,
            scale: material.normalTexture.scale || 1.0
          };
        }
        
        if (material.occlusionTexture) {
          materialInfo.properties.occlusionTexture = {
            index: material.occlusionTexture.index,
            texCoord: material.occlusionTexture.texCoord || 0,
            strength: material.occlusionTexture.strength || 1.0
          };
        }
        
        if (material.emissiveTexture) {
          materialInfo.properties.emissiveTexture = {
            index: material.emissiveTexture.index,
            texCoord: material.emissiveTexture.texCoord || 0
          };
        }

        if (material.alphaCutoff !== undefined) {
          materialInfo.properties.alphaCutoff = material.alphaCutoff;
        }
        
        if (material.alphaMode) {
          materialInfo.properties.alphaMode = material.alphaMode;
        }
        
        if (material.doubleSided !== undefined) {
          materialInfo.properties.doubleSided = material.doubleSided;
        }

        // 添加所有可用的材质属性
        Object.keys(material).forEach(key => {
          if (!materialInfo.properties[key] && key !== 'name' && material[key] !== undefined) {
            const value = material[key];
            // 处理Cesium对象类型
            if (value && typeof value === 'object' && value.constructor.name.startsWith('Cesium')) {
              if (value.x !== undefined && value.y !== undefined) {
                // 向量类型
                materialInfo.properties[key] = value.w !== undefined 
                  ? [value.x, value.y, value.z, value.w]
                  : value.z !== undefined 
                    ? [value.x, value.y, value.z]
                    : [value.x, value.y];
              } else {
                materialInfo.properties[key] = value.toString();
              }
            } else if (typeof value !== 'function') {
              materialInfo.properties[key] = value;
            }
          }
        });

        materials.push(materialInfo);
      });

      console.log('✅ 解析完成，共找到', materials.length, '个材质');
      
    } catch (error) {
      console.error('❌ 获取材质信息失败:', error);
      console.error('❌ 错误堆栈:', error instanceof Error ? error.stack : error);
    }
    
    return materials;
  };

  // 构建材质树结构（使用material.{materialId}.{property}格式）
  const buildMaterialTree = (): ExtendedDataNode[] => {
    // 尝试从Cesium模型获取真实材质数据
    const realMaterials = getMaterialsFromCesiumModel();
    
    // 如果没有找到真实材质，使用示例数据
    const materialsToUse = realMaterials.length > 0 ? realMaterials : [
      {
        id: 'material_0',
        name: 'BaseMaterial',
        properties: {
          baseColorFactor: [1.0, 1.0, 1.0, 1.0],
          metallicFactor: 0.0,
          roughnessFactor: 1.0,
          emissiveFactor: [0.0, 0.0, 0.0],
          baseColorTexture: { index: -1, texCoord: 0 }
        },
        textures: {}
      },
      {
        id: 'material_1', 
        name: 'MetallicMaterial',
        properties: {
          baseColorFactor: [0.8, 0.8, 0.9, 1.0],
          metallicFactor: 1.0,
          roughnessFactor: 0.2,
          emissiveFactor: [0.0, 0.0, 0.0],
          baseColorTexture: { index: -1, texCoord: 0 }
        },
        textures: {}
      }
    ];

    return materialsToUse.map((material, index) => {
      const materialKey = `material-${index}`;
      const materialId = material.id.replace('material_', '');
      
      const materialTitle = (
        <span>
          <strong>{material.name}</strong>
          <Tag style={{ 
            marginLeft: 8, 
            fontSize: '12px', 
            backgroundColor: realMaterials.length > 0 ? '#f6ffed' : '#f6f6f6',
            color: realMaterials.length > 0 ? '#52c41a' : '#666'
          }}>
            {realMaterials.length > 0 ? '真实材质' : '示例材质'}
          </Tag>
          <span style={{ marginLeft: 8, color: '#666', fontSize: '12px' }}>
            ID: {materialId}
          </span>
        </span>
      );

      const materialNode: ExtendedDataNode = {
        key: materialKey,
        title: materialTitle,
        data: { 
          path: iotBindingAPI.buildTargetPath(TargetType.MATERIAL, materialId),
          value: material, 
          type: 'material'
        },
        children: [
          // 材质属性
          ...Object.keys(material.properties).map((propKey, propIndex) => {
            const propValue = (material.properties as any)[propKey];
            return {
              key: `${materialKey}-prop-${propIndex}`,
              title: (
                <span>
                  <strong>{propKey}</strong>
                  <span style={{ marginLeft: 8, color: '#666' }}>
                    : {Array.isArray(propValue) ? `[${propValue.join(', ')}]` : 
                       typeof propValue === 'object' && propValue !== null ? 
                       safeStringify(propValue) : String(propValue)}
                  </span>
                  <Tag style={{ marginLeft: 8, fontSize: '12px' }}>
                    {Array.isArray(propValue) ? 'array' : typeof propValue}
                  </Tag>
                </span>
              ),
              data: { 
                path: iotBindingAPI.buildTargetPath(TargetType.MATERIAL, materialId, propKey),
                value: propValue,
                type: Array.isArray(propValue) ? 'array' : typeof propValue
              }
            } as ExtendedDataNode;
          }),
          // 纹理信息（如果有的话）
          ...(material.textures && Object.keys(material.textures).length > 0 ? 
            Object.keys(material.textures).map((textureKey, textureIndex) => {
              const textureValue = (material.textures as any)[textureKey];
              return {
                key: `${materialKey}-texture-${textureIndex}`,
                title: (
                  <span>
                    <strong>🖼️ {textureKey}</strong>
                    <span style={{ marginLeft: 8, color: '#666' }}>
                      : {textureValue.type || 'texture'}
                      {textureValue.url && ' (有图像)'}
                    </span>
                    <Tag style={{ marginLeft: 8, fontSize: '12px', backgroundColor: '#e6f7ff', color: '#1890ff' }}>
                      texture
                    </Tag>
                  </span>
                ),
                data: { 
                  path: iotBindingAPI.buildTargetPath(TargetType.MATERIAL, materialId, `textures.${textureKey}`),
                  value: textureValue,
                  type: 'texture'
                }
              } as ExtendedDataNode;
            }) : []
          )
        ]
      };

      return materialNode;
    });
  };

  const availableNodes = getAvailableNodes();

  return (
    <Modal
      title={
        <Space>
          <AimOutlined />
          选择目标属性
        </Space>
      }
      open={visible}
      onCancel={onClose}
      footer={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={
          activeTab === 'properties' ? fetchInstanceProperties : 
          activeTab === 'materials' ? refreshMaterials : () => {}
        } loading={loading}>
          {activeTab === 'properties' ? '刷新属性' : 
           activeTab === 'nodes' ? '刷新节点' : '刷新材质'}
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="confirm" type="primary" onClick={handleConfirmPath} disabled={!selectedPath}>
          {activeTab === 'properties' ? '选择此属性' : 
           activeTab === 'nodes' ? '选择此节点' : '选择此材质'}
        </Button>
      ]}
      width={800}
      destroyOnClose
      zIndex={1020}
    >
      <Row gutter={16}>
        <Col span={16}>
          <Card
            size="small"
            tabList={[
              { key: 'properties', tab: '实例属性' },
              { key: 'nodes', tab: '模型节点' },
              { key: 'materials', tab: '材质属性' }
            ]}
            activeTabKey={activeTab}
            onTabChange={handleTabChange}
            extra={
              <Space>
                {loading && <Spin size="small" />}
                <Button 
                  size="small" 
                  icon={<ReloadOutlined />}
                  onClick={
                    activeTab === 'properties' ? fetchInstanceProperties :
                    activeTab === 'materials' ? refreshMaterials : () => {}
                  }
                >
                  {activeTab === 'properties' ? '刷新属性' : 
                   activeTab === 'nodes' ? '刷新节点' : '刷新材质'}
                </Button>
              </Space>
            }
          >
            {activeTab === 'properties' ? (
              instanceProperties ? (
                <Tree
                  treeData={buildPropertyTree(instanceProperties, '', '0', true)}
                  onSelect={handleTreeSelect}
                  expandedKeys={expandedKeys}
                  onExpand={handleTreeExpand}
                  defaultExpandAll
                  height={400}
                  style={{ overflow: 'auto' }}
                />
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  {loading ? '正在加载属性...' : '暂无属性数据'}
                </div>
              )
            ) : activeTab === 'nodes' ? (
              availableNodes.length > 0 ? (
                <Tree
                  treeData={buildNodeTree(availableNodes)}
                  onSelect={handleTreeSelect}
                  expandedKeys={expandedKeys}
                  onExpand={handleTreeExpand}
                  defaultExpandAll
                  height={400}
                  style={{ overflow: 'auto' }}
                />
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <Alert
                    type="info"
                    message="无节点数据"
                    description="当前模型没有可用的节点数据。节点数据来自动画系统，请确保模型已加载并包含动画节点信息。"
                    showIcon
                    style={{ textAlign: 'left' }}
                  />
                </div>
              )
            ) : (
              // 材质选项卡
              materialTreeData.length > 0 ? (
                <Tree
                  treeData={materialTreeData}
                  onSelect={handleTreeSelect}
                  expandedKeys={expandedKeys}
                  onExpand={handleTreeExpand}
                  defaultExpandAll
                  height={400}
                  style={{ overflow: 'auto' }}
                />
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <Alert
                    type="info"
                    message="无材质数据"
                    description="当前模型没有可用的材质数据。请确保模型已加载并包含材质信息，或点击刷新按钮重新获取。"
                    showIcon
                    style={{ textAlign: 'left' }}
                  />
                </div>
              )
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card title={
            activeTab === 'properties' ? '属性选择' : 
            activeTab === 'nodes' ? '节点选择' : '材质选择'
          } size="small">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Text strong>{
                  activeTab === 'properties' ? '选中的属性:' : 
                  activeTab === 'nodes' ? '选中的节点:' : '选中的材质:'
                }</Text>
                <Input 
                  value={selectedPath} 
                  onChange={(e) => setSelectedPath(e.target.value)}
                  placeholder={
                    activeTab === 'properties' ? '点击左侧属性节点选择路径' : 
                    activeTab === 'nodes' ? '点击左侧节点选择路径' : '点击左侧材质选择路径'
                  }
                  style={{ marginTop: 8 }}
                />
              </div>
              
              {selectedPath && (
                <Alert
                  type="success"
                  showIcon
                  message={
                    activeTab === 'properties' ? '属性路径有效' : 
                    activeTab === 'nodes' ? '节点路径有效' : '材质路径有效'
                  }
                  description={`${
                    activeTab === 'properties' ? '目标属性' : 
                    activeTab === 'nodes' ? '目标节点' : '目标材质'
                  }: ${selectedPath}`}
                />
              )}

              {/* 材质预览图 */}
              {activeTab === 'materials' && (
                <div>
                  <Divider />
                  <div>
                    <Text strong style={{ marginBottom: 8, display: 'block' }}>材质预览:</Text>
                    <MaterialPreview 
                      selectedPath={selectedPath}
                      materials={materialTreeData}
                      viewerRef={viewerRef}
                    />
                  </div>
                </div>
              )}

              <Divider />
              
              <div>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  <InfoCircleOutlined style={{ marginRight: 4 }} />
                  {activeTab === 'properties' 
                    ? '选择实例的属性作为IoT数据的目标路径。格式：instance.{property}.{key}'
                    : activeTab === 'nodes'
                    ? '选择模型的节点作为IoT数据的目标。格式：node.{nodeId}.{property}。节点数据来自动画系统。'
                    : '选择模型的材质作为IoT数据的目标。格式：material.{materialId}.{property}。'
                  }
                </Text>
                {activeTab === 'nodes' && (
                  <Alert 
                    type="info" 
                    message="节点数据来源" 
                    description={
                      <div>
                        <p>节点数据来自动画系统，当前状态：</p>
                        <ul style={{marginLeft: 16, marginBottom: 0}}>
                          <li><strong>可用节点数：</strong> {availableNodes.length}</li>
                          <li><strong>动画状态：</strong> {animationState ? '已加载' : '未加载'}</li>
                          <li><strong>选中模型：</strong> {animationState?.selectedModelId || '无'}</li>
                        </ul>
                        {animationState?.isLoading && (
                          <p style={{marginTop: 8, marginBottom: 0, color: '#1890ff'}}>
                            🔄 正在加载动画数据...
                          </p>
                        )}
                      </div>
                    } 
                    style={{ marginTop: 12, fontSize: '12px' }}
                    showIcon
                  />
                )}
                {activeTab === 'materials' && (
                  <Alert 
                    type="info" 
                    message="材质数据来源" 
                    description={
                      <div>
                        <p>材质数据通过ModelComponents从glTF模型中获取，当前状态：</p>
                        <ul style={{marginLeft: 16, marginBottom: 0}}>
                          <li><strong>可用材质数：</strong> {materialTreeData.length}</li>
                          <li><strong>数据来源：</strong> {materialTreeData.length > 0 && materialTreeData[0]?.title?.props?.children?.[1]?.props?.children === '真实材质' ? 'Cesium ModelComponents' : '示例数据'}</li>
                          <li><strong>选中模型：</strong> {animationState?.selectedModelId || '无'}</li>
                        </ul>
                        <p style={{marginTop: 8, marginBottom: 0, fontSize: '11px', color: '#666'}}>
                          💡 如果显示示例数据，请确保模型已正确加载并包含材质信息，然后点击刷新按钮。
                        </p>
                      </div>
                    } 
                    style={{ marginTop: 12, fontSize: '12px' }}
                    showIcon
                  />
                )}
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </Modal>
  );
};

// 主要的数据路径辅助组件
const DataPathHelper: React.FC<DataPathHelperProps> = ({
  protocol,
  connectionId,
  onSourcePathSelect,
  onTargetPathSelect,
  instanceId,
  sceneId,
  modelId,
  viewerRef,
  selectedModelId,
  animationState
}) => {
  const [dataPreviewVisible, setDataPreviewVisible] = useState(false);
  const [propertySelectorVisible, setPropertySelectorVisible] = useState(false);

  return (
    <>
      <Space>
        <Button
          icon={<EyeOutlined />}
          onClick={() => setDataPreviewVisible(true)}
          disabled={!connectionId}
        >
          预览数据
        </Button>
        <Button
          icon={<AimOutlined />}
          onClick={() => setPropertySelectorVisible(true)}
        >
          选择属性
        </Button>
      </Space>

      <DataPreviewModal
        visible={dataPreviewVisible}
        protocol={protocol}
        connectionId={connectionId}
        onClose={() => setDataPreviewVisible(false)}
        onPathSelect={onSourcePathSelect}
      />

      <PropertySelectorModal
        visible={propertySelectorVisible}
        instanceId={instanceId}
        onClose={() => setPropertySelectorVisible(false)}
        onPathSelect={onTargetPathSelect}
        animationState={animationState}
        viewerRef={viewerRef}
        selectedModelId={selectedModelId}
      />
    </>
  );
};

export default DataPathHelper;
export { DataPreviewModal }; 