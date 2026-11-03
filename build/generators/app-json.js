/**
 * app.json 生成器
 * 从 app.config.js 和 components.config.js 提取元数据自动生成 app.json 文件
 */

import appConfig from '../../config/app.config.js';
import { writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// 获取 @sun-panel/micro-app 包的版本号
const microAppEntryPath = require.resolve('@sun-panel/micro-app');
const microAppRoot = dirname(dirname(microAppEntryPath));
const SP_API_VERSION = JSON.parse(readFileSync(join(microAppRoot, 'package.json'), 'utf-8')).version;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 判断是否为测试模式
 * 根据打包命令的 NODE_ENV 来判断
 */
const isTest = process.env.NODE_ENV === 'development';

/**
 * 从 components.config.js 文件提取元数据（不导入组件）
 */
function extractComponentsMeta() {
  const componentsConfigPath = join(__dirname, '../../config/components.config.js');
  const content = readFileSync(componentsConfigPath, 'utf-8');
  
  // 移除 import 语句
  let code = content.replace(/import\s+.*?from\s+['"][\w\-/.@]+['"];\s*/g, '');
  
  // 移除 export default
  code = code.replace(/export\s+default\s+/, '');
  
  // 将所有 component: HomePage 等替换成 component: null
  code = code.replace(/component:\s*\w+/g, 'component: null');
  
  // 移除结尾的分号
  code = code.trim().replace(/;$/, '');
  
  // 使用 eval 安全地解析
  const componentsMeta = eval(`(${code})`);
  
  return componentsMeta;
}

/**
 * 生成 app.json 文件
 * 注意：组件名保持原样，标签名由主应用在注册时生成
 */
function generateAppJson() {
  // 应用级配置整体透传（microAppId 需拼接 -test 后缀，故单独取出）
  const { microAppId, ...restConfig } = appConfig;
  const components = extractComponentsMeta();

  // 测试模式下自动添加 -test 后缀
  const finalMicroId = isTest ? `${microAppId}-test` : microAppId;

  // 构建 app.json 对象（其余配置项全部透传，新增配置无需修改此脚本）
  const appJson = {
    ...restConfig,
    appJsonVersion: restConfig.appJsonVersion || '1.0',
    microAppId: finalMicroId,
    // 测试模式自动开启 debug 方便调试，生产模式透传配置值（由 config/app.config.js 控制）
    debug: isTest ? true : restConfig.debug,
    apiVersion: SP_API_VERSION,
    components: {}
  };

  // 构建组件配置（保持原始组件名，不生成标签名）
  const componentsConfig = {
    pages: {},
    widgets: {}
  };

  // 处理页面组件（使用原始组件名）
  // 排除 component（JS 对象引用，无法序列化），其余字段全部透传
  // 新增配置项无需再修改此脚本
  if (components.pages) {
    for (const [name, page] of Object.entries(components.pages)) {
      const pageMeta = { ...page };
      delete pageMeta.component;
      componentsConfig.pages[name] = pageMeta;
    }
  }

  // 处理小部件组件（使用原始组件名）
  if (components.widgets) {
    for (const [name, widget] of Object.entries(components.widgets)) {
      const widgetMeta = { ...widget };
      delete widgetMeta.component;
      componentsConfig.widgets[name] = widgetMeta;
    }
  }

  appJson.components = componentsConfig;

  // 写入 app.json 文件
  const outputPath = join(__dirname, '../../app.json');
  writeFileSync(outputPath, JSON.stringify(appJson, null, 2), 'utf-8');

  console.log(`✅ app.json generated: ${outputPath}`);
  console.log(`📦 App: ${finalMicroId}`);
  console.log(`🔧 Environment: ${isTest ? 'test' : 'production'}`);
  console.log(`📄 Pages: ${Object.keys(componentsConfig.pages).join(', ')}`);
  console.log(`🎨 Widgets: ${Object.keys(componentsConfig.widgets).join(', ')}`);

  return appJson;
}

// 生成并导出
const appJson = generateAppJson();
export default appJson;
export { generateAppJson };
