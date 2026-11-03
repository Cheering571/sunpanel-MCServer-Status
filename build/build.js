/**
 * Build script
 * Generate configuration files and component registration info
 *
 * v1.1: 自动检测 appJsonVersion，提示升级并执行升级逻辑
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 从文件内容中提取 appJsonVersion
 */
function extractAppJsonVersion(content) {
  const match = content.match(/appJsonVersion\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * 安全地从 JS 对象字面量字符串中提取指定属性块
 * 通过大括号匹配提取 appInfo 的内容
 */
function extractObjectBlock(content, key) {
  // 找到属性名的位置
  const keyPattern = new RegExp(`(?:^|\\n|,)\\s*${key}\\s*:\\s*\\{`);
  const keyMatch = content.match(keyPattern);
  if (!keyMatch) return null;

  const startIdx = content.indexOf(keyMatch[0]) + keyMatch[0].length - 1; // 指向 { 的位置
  let depth = 0;
  let endIdx = startIdx;

  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }

  return content.substring(startIdx, endIdx);
}

/**
 * 检测 appInfo 是否为多语言嵌套结构
 * v1.0: appInfo: { 'zh-CN': { ... }, 'en-US': { ... } }
 * v1.1: appInfo: { appName: '$t:APP_NAME', ... }
 */
function isMultiLanguageAppInfo(block) {
  if (!block) return false;

  // 去除外层大括号
  const inner = block.slice(1, -1).trim();
  if (!inner) return false;

  // 尝试解析每个顶层属性
  // 多语言结构的特征：顶层值是对象（嵌套了语言对象）
  // v1.1 结构的特征：顶层值是字符串 '$t:xxx'

  // 匹配顶层属性：提取第一个属性名和值
  const propPattern = /^['"]?([a-zA-Z-]+)['"]?\s*:\s*/;
  const propMatch = inner.match(propPattern);
  if (!propMatch) return false;

  // 查找该属性的值
  const afterProp = inner.substring(propMatch[0].length).trim();

  if (afterProp.startsWith('{')) {
    // 值是对象，说明是 v1.0 多语言结构
    return true;
  } else if (afterProp.startsWith("'$t:") || afterProp.startsWith('"$t:')) {
    // 值是 $t: 引用，说明已是 v1.1
    return false;
  } else {
    // 值是字符串字面量，可能是 v1.0 单语言结构（直接的对象属性）
    return false;
  }
}

/**
 * 将 camelCase 或 kebab-case 转换为 UPPER_SNAKE_CASE
 * name → NAME
 * networkDescription → NETWORK_DESCRIPTION
 * appName → APP_NAME
 */
function toUpperSnakeCase(str) {
  return str
    // 在 camelCase 的大写字母前插入下划线
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    // 转大写
    .toUpperCase();
}

/**
 * 从多语言 appInfo 块中提取各语言数据
 * 返回 { langCode: { key: value, ... }, ... }
 */
function parseMultiLanguageAppInfo(block) {
  const inner = block.slice(1, -1).trim();
  const result = {};

  // 逐个提取语言块
  let remaining = inner;
  const langPattern = /^['"]?([a-zA-Z-]+)['"]?\s*:\s*\{/;

  while (remaining.length > 0) {
    const langMatch = remaining.match(langPattern);
    if (!langMatch) break;

    const langCode = langMatch[1];
    const startIdx = remaining.indexOf(langMatch[0]) + langMatch[0].length - 1;

    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < remaining.length; i++) {
      if (remaining[i] === '{') depth++;
      if (remaining[i] === '}') depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }

    const langBlock = remaining.substring(startIdx, endIdx);
    const langInner = langBlock.slice(1, -1).trim();

    // 解析语言块内的键值对
    const props = {};
    const kvPattern = /['"]?([a-zA-Z-]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
    let kvMatch;
    while ((kvMatch = kvPattern.exec(langInner)) !== null) {
      props[kvMatch[1]] = kvMatch[2];
    }

    result[langCode] = props;
    remaining = remaining.substring(endIdx).trim();
    if (remaining.startsWith(',')) remaining = remaining.substring(1).trim();
  }

  return result;
}

/**
 * 标准化语言代码
 * 'zh-cn' -> 'zh-CN', 'en' -> 'en-US', 'en-US' -> 'en-US'
 */
function normalizeLangCode(code) {
  const map = {
    'zh-cn': 'zh-CN', 'zh': 'zh-CN',
    'zh-tw': 'zh-TW', 'zh-hk': 'zh-HK',
    'en': 'en-US', 'en-us': 'en-US',
    'ja': 'ja-JP', 'ko': 'ko-KR',
    'fr': 'fr-FR', 'de': 'de-DE',
    'es': 'es-ES', 'pt': 'pt-BR',
    'ru': 'ru-RU', 'it': 'it-IT',
  };
  const lower = code.toLowerCase();
  return map[lower] || code;
}

/**
 * 验证生成的配置文件语法是否正确
 * 使用临时文件 + node --check 进行语法校验
 */
function validateConfigSyntax(content) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'build-'));
  const tmpFile = join(tmpDir, 'app.config.js');
  const tmpPackageJson = join(tmpDir, 'package.json');
  try {
    // 创建 package.json 以启用 ES 模块支持
    writeFileSync(tmpPackageJson, JSON.stringify({ type: 'module' }, null, 2), 'utf-8');
    writeFileSync(tmpFile, content, 'utf-8');
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error('❌ 生成的配置文件语法错误：');
    console.error(e.stderr?.toString() || e.message);
    return false;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(tmpPackageJson); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 创建翻译文件
 */
function createLocaleFile(localesDir, langCode, translations) {
  if (!existsSync(localesDir)) {
    mkdirSync(localesDir, { recursive: true });
  }

  // 生成文件内容
  const entries = Object.entries(translations)
    .map(([key, value]) => `  ${key}: '${value.replace(/'/g, "\\'")}',`)
    .join('\n');

  const content = `/**
 * ${langCode} 翻译文件
 * 格式：{ "KEY": "value" }
 * 此文件由升级脚本自动生成
 */

export default {
${entries}
};
`;

  const filePath = join(localesDir, `${langCode}.js`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * 根据原始配置生成 v1.1 格式的配置文件内容
 * @param {string} originalContent - 原始配置文件内容
 * @param {object} localesData - 包含 locales 和 appInfoTemplate 的对象
 * @param {string} defaultLocale - 默认语言代码
 * @param {boolean} useTranslation - 是否使用 $t: 语法（true=多语言，false=单语言）
 */
function generateV1ConfigContent(originalContent, localesData, defaultLocale, useTranslation = true) {
  let content = originalContent;

  // 1. 更新 appJsonVersion
  if (content.match(/appJsonVersion\s*:/)) {
    content = content.replace(
      /appJsonVersion\s*:\s*['"][^'"]+['"]/,
      `appJsonVersion: '1.1'`
    );
  } else {
    // 在 export default 之后、第一个属性之前插入
    content = content.replace(
      /export\s+default\s*\{/,
      `export default {\n  // 配置文件格式版本\n  appJsonVersion: '1.1',`
    );
  }

  // 2. 替换 appInfo 块
  // 找到 appInfo 的起始位置和结束位置
  const appInfoKeyIdx = content.indexOf('appInfo:');
  if (appInfoKeyIdx !== -1) {
    // 找到 appInfo 值的起始 {
    const openBraceIdx = content.indexOf('{', appInfoKeyIdx);
    if (openBraceIdx !== -1) {
      let depth = 0;
      let closeBraceIdx = openBraceIdx;
      for (let i = openBraceIdx; i < content.length; i++) {
        if (content[i] === '{') depth++;
        if (content[i] === '}') depth--;
        if (depth === 0) {
          closeBraceIdx = i;
          break;
        }
      }

      // 构建新的 appInfo 内容
      let appInfoEntries;
      if (useTranslation) {
        // 多语言：使用 $t: 语法
        appInfoEntries = Object.entries(localesData['appInfoTemplate'])
          .map(([key, value]) => `    ${key}: '${value}',`)
          .join('\n');
      } else {
        // 单语言：直接使用翻译值
        const translations = localesData['translations'];
        appInfoEntries = Object.entries(translations)
          .map(([key, value]) => `    ${key}: '${value.replace(/'/g, "\\'")}',`)
          .join('\n');
      }

      const newAppInfo = `appInfo: {\n${appInfoEntries}\n  }`;
      content = content.substring(0, appInfoKeyIdx) + newAppInfo + content.substring(closeBraceIdx + 1);
    }
  }

  // 3. 添加 locales 和 defaultLocale（仅多语言模式）
  if (useTranslation) {
    const hasLocales = content.includes('locales:');
    const hasDefaultLocale = content.includes('defaultLocale:');

    const localesObj = Object.entries(localesData.locales)
      .map(([lang, file]) => `    '${lang}': '${file}',`)
      .join('\n');

    const configComments = `
  // 语言文件映射（appJsonVersion:1.1 新增）
  // 格式：{ 语言代码: 文件名 }
  // 文件名相对于 locales/ 目录，支持多语言代码指向同一文件
  locales: {
${localesObj}
  },

  // 默认语言（当主应用语言在微应用中不存在时，回退到此语言）
  // 如果不设置，默认为 'en-US'
  defaultLocale: '${defaultLocale}',`;

    if (hasLocales || hasDefaultLocale) {
      // 如果已存在，替换
      if (hasLocales) {
        const localesIdx = content.indexOf('locales:');
        const localesEndIdx = findClosingBrace(content, localesIdx);
        if (localesEndIdx !== -1) {
          content = content.substring(0, localesIdx) + `locales: {\n${localesObj}\n  }` + content.substring(localesEndIdx + 1);
        }
      }
      if (hasDefaultLocale) {
        content = content.replace(
          /defaultLocale\s*:\s*['"][^'"]+['"]/,
          `defaultLocale: '${defaultLocale}'`
        );
      }
    } else {
      // 在 appInfo 之后添加
      const appInfoEnd = findAppInfoEnd(content);
      if (appInfoEnd !== -1) {
        // appInfoEnd 指向 appInfo 的闭合 }
        // 跳过 } 和其后的逗号及空白，找到下一个属性的起始位置
        let insertPos = appInfoEnd + 1;
        while (insertPos < content.length && /[\s,]/.test(content[insertPos])) {
          insertPos++;
        }
        content = content.substring(0, appInfoEnd + 1) + ',\n' + configComments + '\n' + content.substring(insertPos);
      }
    }
  }

  return content;
}

/**
 * 查找从指定位置开始的匹配右大括号
 */
function findClosingBrace(content, startIdx) {
  const openIdx = content.indexOf('{', startIdx);
  if (openIdx === -1) return -1;
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    if (depth === 0) return i;
  }
  return -1;
}

/**
 * 查找 appInfo 块的结束位置
 */
function findAppInfoEnd(content) {
  const appInfoIdx = content.indexOf('appInfo:');
  if (appInfoIdx === -1) return -1;
  return findClosingBrace(content, appInfoIdx);
}

/**
 * 核心升级逻辑
 */
async function upgradeAppConfig(configPath, originalContent) {
  const appInfoBlock = extractObjectBlock(originalContent, 'appInfo');
  if (!appInfoBlock) {
    console.log('⚠️  无法解析 appInfo，跳过升级');
    return;
  }

  const localesDir = join(dirname(configPath), '../locales');
  const localesData = { locales: {}, appInfoTemplate: {}, translations: {} };
  let defaultLocale = 'en-US';
  let useTranslation = true; // 默认使用 $t: 语法

  if (isMultiLanguageAppInfo(appInfoBlock)) {
    // ===== v1.0 多语言嵌套结构 =====
    console.log('📝 检测到 v1.0 多语言嵌套结构，开始转换...');

    const langDataMap = parseMultiLanguageAppInfo(appInfoBlock);
    const langCodes = Object.keys(langDataMap);
    console.log(`   发现 ${langCodes.length} 个语言：${langCodes.join(', ')}`);

    if (langCodes.length === 1) {
      // ===== 只有1种语言：直接展平 =====
      console.log('   单语言模式：直接展平语言内容赋给 appInfo');
      const langCode = langCodes[0];
      const translations = langDataMap[langCode];
      
      // 直接使用翻译内容
      localesData.translations = translations;
      useTranslation = false;
      
      console.log(`   ✅ 将 ${langCode} 语言的内容直接赋给 appInfo`);
    } else {
      // ===== 多种语言：使用 $t: 语法 =====
      console.log('   多语言模式：使用 $t: 语法并创建翻译文件');
      
      // 收集所有翻译键（以第一个语言为基准）
      const templateKeys = Object.keys(langDataMap[langCodes[0]]);

      // 创建 appInfo 模板（使用 $t: 引用）
      for (const key of templateKeys) {
        localesData.appInfoTemplate[key] = `$t:${toUpperSnakeCase(key)}`;
      }

      // 为每个语言创建翻译文件
      for (const langCode of langCodes) {
        const normalized = normalizeLangCode(langCode);
        const translations = langDataMap[langCode];

        // 翻译键也做一次映射：原始 key -> UPPER_SNAKE_CASE
        const upperTranslations = {};
        for (const [k, v] of Object.entries(translations)) {
          upperTranslations[toUpperSnakeCase(k)] = v;
        }

        createLocaleFile(localesDir, normalized, upperTranslations);
        localesData.locales[normalized] = `${normalized}.js`;
        console.log(`   ✅ 创建翻译文件：locales/${normalized}.js`);
      }

      // 设置默认语言
      if (localesData.locales['en-US']) {
        defaultLocale = 'en-US';
      } else if (localesData.locales['en']) {
        defaultLocale = 'en';
      } else {
        defaultLocale = normalizeLangCode(langCodes[0]);
      }
    }

  } else {
    console.log('ℹ️  appInfo 已使用 $t: 语法或格式未知，无需升级');
    return;
  }

  // 生成新的配置文件内容
  const newContent = generateV1ConfigContent(originalContent, localesData, defaultLocale, useTranslation);

  // 语法校验
  if (!validateConfigSyntax(newContent)) {
    console.error('\n❌ 升级失败：生成的配置文件语法不正确，已中止写入');
    return;
  }

  writeFileSync(configPath, newContent, 'utf-8');

  console.log('\n✅ 配置文件已更新为 v1.1 格式：');
  console.log(`   - appJsonVersion: '1.1'`);
  if (useTranslation) {
    console.log(`   - appInfo: 使用 $t:KEY 语法`);
    console.log(`   - locales: ${Object.keys(localesData.locales).join(', ')}`);
    console.log(`   - defaultLocale: '${defaultLocale}'`);
  } else {
    console.log(`   - appInfo: 直接使用翻译内容`);
  }
}

/**
 * 检查并升级 appJsonVersion
 * @param {boolean} autoUpgrade - 是否自动升级（跳过交互提示）
 */
async function checkAndUpgradeAppJsonVersion(autoUpgrade = false) {
  const appConfigPath = join(__dirname, '../config/app.config.js');

  if (!existsSync(appConfigPath)) {
    console.log('⚠️  config/app.config.js 不存在，跳过版本检查');
    return;
  }

  const content = readFileSync(appConfigPath, 'utf-8');
  const currentVersion = extractAppJsonVersion(content);

  // 不存在 appJsonVersion 或值为 1.0 时触发询问
  if (!currentVersion || currentVersion === '1.0') {
    const versionDisplay = currentVersion || '不存在';

    if (autoUpgrade) {
      // 非交互模式：自动升级
      console.log(`\n🚀 当前 appJsonVersion: ${versionDisplay}，自动升级到 v1.1...\n`);
      await upgradeAppConfig(appConfigPath, content);
    } else {
      // 交互模式：询问用户
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question(`当前 appJson 配置文件（appJsonVersion: ${versionDisplay}）过低，后续将不再支持，是否自动升级到 1.1 版本？(y/N) `, resolve);
      });
      rl.close();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'y' || trimmed === 'yes' || trimmed === '是') {
        console.log('\n🚀 开始升级 app.config.js 到 v1.1...\n');
        await upgradeAppConfig(appConfigPath, content);
      } else {
        console.log('⚠️  跳过升级，继续使用当前版本编译。\n');
      }
    }
  }
}

// ============================================================
// 主流程
// ============================================================

// 解析命令行参数：--yes 表示非交互模式（自动升级）
const autoUpgrade = process.argv.includes('--yes');

console.log('\n🚀 Building...\n');

// 检查并升级 appJsonVersion
await checkAndUpgradeAppJsonVersion(autoUpgrade);

// 动态导入其他模块
const { generateAppJson } = await import('./generators/app-json.js');

// Generate app.json
generateAppJson();

console.log('\n✅ Build completed!\n');
