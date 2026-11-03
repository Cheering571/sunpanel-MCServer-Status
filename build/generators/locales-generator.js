/**
 * 翻译文件编译器
 * 将 locales/ 目录下的 .js 翻译文件编译为 .json 文件
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 编译翻译文件
 */
export function compileLocales() {
  const localesDir = join(__dirname, '../../locales');
  const outputDir = join(__dirname, '../../dist/locales');
  
  // 确保输出目录存在
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  // 检查 locales 目录是否存在
  if (!existsSync(localesDir)) {
    console.warn('⚠️  locales directory not found:', localesDir);
    return;
  }
  
  // 读取所有 .js 文件
  const files = readdirSync(localesDir).filter(file => file.endsWith('.js'));
  
  if (files.length === 0) {
    console.warn('⚠️  No .js files found in locales directory');
    return;
  }
  
  files.forEach(file => {
    const locale = file.replace('.js', '');
    const sourcePath = join(localesDir, file);
    
    try {
      // 读取并解析 .js 文件
      const content = readFileSync(sourcePath, 'utf-8');
      
      // 移除 export default 并解析对象
      // 注意：不要手动移除注释，vm 模块会自动处理
      // 手动移除注释会破坏字符串中的 //（如 http://）
      const cleanContent = content
        .replace(/^\uFEFF/, '')  // 移除 BOM
        .replace(/export\s+default\s+/, '')
        .replace(/;$/, '')
        .trim();
      
      // 使用 vm 模块解析（比 new Function 更安全，且能正确处理注释）
      const translations = vm.runInNewContext('(' + cleanContent + ')');
      
      // 编译为 JSON
      const json = JSON.stringify(translations, null, 2);
      const outputPath = join(outputDir, `${locale}.json`);
      writeFileSync(outputPath, json, 'utf-8');
      
      console.log(`✅ Compiled ${file} -> ${locale}.json`);
    } catch (error) {
      console.error(`❌ Error compiling ${file}:`, error.message);
    }
  });
}