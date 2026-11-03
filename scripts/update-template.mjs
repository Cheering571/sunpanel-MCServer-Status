#!/usr/bin/env node

/**
 * 微应用模板更新脚本
 *
 * 用于将 microapp-hello-world 模板的最新代码同步到衍生项目
 * 支持跨平台：Windows、macOS、Linux
 *
 * 使用方法（在衍生项目根目录）：
 *   npm run update          交互模式：展示 diff，确认后更新
 *   npm run update:force    强制模式：直接覆盖
 *
 * 高级用法：
 *   node scripts/update-template.mjs --help    查看帮助
 *   node scripts/update-template.mjs --local   使用本地模板
 *   node scripts/update-template.mjs -f        强制覆盖
 *   node scripts/update-template.mjs --dry-run 干运行（仅报告不执行）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { createInterface } from 'readline';

// ==================== 常量 ====================

const SCRIPT_DIR = (() => {
  const pathname = new URL('.', import.meta.url).pathname;
  // Windows 上 pathname 会有前导斜杠（如 /C:/Users/...），需要去除
  return process.platform === 'win32' && pathname.startsWith('/') ? pathname.slice(1) : pathname;
})();
const TEMPLATE_DIR = join(SCRIPT_DIR, '..');
const TEMPLATE_FILES_PATH = join(SCRIPT_DIR, 'template-files.json');
const SYNC_INFO_FILE = '.template-sync-info.json';

// ==================== 颜色输出 ====================

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function log(color, msg) {
  console.log(`${color}${msg}${colors.reset}`);
}

function logSuccess(msg) { log(colors.green, `  ✅ ${msg}`); }
function logError(msg)   { log(colors.red,   `  ❌ ${msg}`); }
function logInfo(msg)    { log(colors.cyan,  `  ℹ️  ${msg}`); }
function logWarning(msg) { log(colors.yellow, `  ⚠️  ${msg}`); }
function logStep(msg)    { log(colors.bold,  `\n🔧 ${msg}`); }
function logDry(msg)     { log(colors.gray,  `  🔍 ${msg}`); }

// ==================== 帮助信息 ====================

function showHelp() {
  const help = `
${colors.bold}微应用模板更新工具${colors.reset}
  将 microapp-hello-world 模板的构建代码同步到衍生项目

${colors.bold}用法:${colors.reset}
  npm run update            交互模式（展示 diff，确认后更新）
  npm run update:force      强制模式（直接覆盖）

  node scripts/update-template.mjs [选项]

${colors.bold}选项:${colors.reset}
  -h, --help        显示此帮助信息
  -f, --force       强制覆盖，跳过 diff 展示和确认提示
  --local [path]    使用本地模板目录（不从 GitHub 拉取），可选指定路径
  --dry-run         干运行模式：仅生成变更报告，不执行任何修改
  --no-stash        更新前不自动 git stash（默认会自动 stash 安全备份）

${colors.bold}安全检查:${colors.reset}
  更新前会检查工作区是否干净，如有未提交的更改将询问是否自动 stash
  选择"是"：自动 stash 修改，更新完成后提示你 git stash pop 恢复
  选择"否"：终止更新，你可手动处理修改

${colors.bold}示例:${colors.reset}
  ${colors.cyan}# 在衍生项目根目录执行${colors.reset}
  npm run update
  npm run update:force

  ${colors.cyan}# 预览变更（不执行）${colors.reset}
  node scripts/update-template.mjs --dry-run

  ${colors.cyan}# 使用本地模板目录（默认模板目录）${colors.reset}
  node scripts/update-template.mjs --local

  ${colors.cyan}# 使用自定义本地模板目录${colors.reset}
  node scripts/update-template.mjs --local /path/to/template

  ${colors.cyan}# 从模板项目更新另一个项目（本地模式）${colors.reset}
  node scripts/update-template.mjs /path/to/derived-project --local --force

${colors.bold}同步的文件:${colors.reset}
  vite.config.js, build/**, eslint.config.js, package.json,
  jsconfig.json, scripts/**, src/main.js, src/vite-env.d.ts

${colors.bold}清理的废弃文件:${colors.reset}
  src/builtins/**, src/utils/assetPath.js
  (升级时自动删除模板中不再需要的旧文件)

${colors.bold}不会更新的文件:${colors.reset}
  src/components/**, config/**, app.json, public/**, locales/**, dist/**

${colors.bold}模板版本管理:${colors.reset}
  package.json 中的 templateName / templateVersion 字段记录当前项目
  所基于的模板名称与版本。执行更新时，模板源的新版本号会自动覆盖
  这两个字段；name / version 属于你的应用，不会被覆盖。
`;
  console.log(help);
}

// ==================== 参数解析 ====================

function parseArgs() {
  const rawArgs = process.argv.slice(2);

  const flags = {
    help: false,
    force: false,
    local: false,
    noStash: false,
    dryRun: false,
  };
  let targetDir = null;
  let localPath = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    
    switch (arg) {
      case '-h':
      case '--help':
        flags.help = true;
        break;
      case '-f':
      case '--force':
        flags.force = true;
        break;
      case '--local':
        flags.local = true;
        // 检查下一个参数是否是路径（非 - 开头）
        if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
          localPath = rawArgs[i + 1];
          i++; // 跳过路径参数
        }
        break;
      case '--no-stash':
        flags.noStash = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          targetDir = arg;
        }
        break;
    }
  }

  return {
    flags,
    targetDir: targetDir || process.cwd(),
    localPath,
  };
}

// ==================== 交互确认 ====================

function askConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${colors.yellow}  ❓ ${question} (y/N): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function askConflictChoice(filePath) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`${colors.yellow}  📄 ${filePath} 有本地修改${colors.reset}`);
    console.log(`    ${colors.bold}1${colors.reset}) ${colors.red}覆盖${colors.reset} — 用模板版本替换本地修改`);
    console.log(`    ${colors.bold}2${colors.reset}) ${colors.green}保留${colors.reset} — 跳过此文件，保留本地修改`);
    console.log(`    ${colors.bold}3${colors.reset}) ${colors.cyan}跳过全部${colors.reset} — 取消所有后续文件的更新`);
    rl.question(`${colors.yellow}  请选择 [1/2/3]: ${colors.reset}`, (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === '2') resolve('keep');
      else if (choice === '3') resolve('skipAll');
      else resolve('overwrite');
    });
  });
}

// ==================== Diff 对比 ====================

function computeDiff(sourcePath, targetPath) {
  const sourceContent = readFileSync(sourcePath, 'utf-8').split('\n');
  const targetContent = existsSync(targetPath)
    ? readFileSync(targetPath, 'utf-8').split('\n')
    : [];

  const diffs = [];
  const maxLines = Math.max(sourceContent.length, targetContent.length);

  for (let i = 0; i < maxLines; i++) {
    const srcLine = sourceContent[i];
    const tgtLine = targetContent[i];

    if (srcLine === tgtLine) continue;

    if (tgtLine !== undefined) {
      diffs.push({ type: 'removed', line: i + 1, content: tgtLine });
    }
    if (srcLine !== undefined) {
      diffs.push({ type: 'added', line: i + 1, content: srcLine });
    }
  }

  return diffs;
}

function showDiff(filePath, diffs) {
  log(colors.bold, `  📄 ${filePath}`);
  const maxLinesToShow = 20;
  const truncated = diffs.length > maxLinesToShow;
  const shown = truncated ? diffs.slice(0, maxLinesToShow) : diffs;

  for (const d of shown) {
    const prefix = d.type === 'added' ? '+' : '-';
    const color = d.type === 'added' ? colors.green : colors.red;
    const lineNum = String(d.line).padStart(4);
    process.stdout.write(`${color}  │ ${prefix} ${lineNum} | ${d.content}${colors.reset}\n`);
  }

  if (truncated) {
    log(colors.gray, `  │ ... 还有 ${diffs.length - maxLinesToShow} 行变更`);
  }
}

// ==================== 通配符展开 ====================

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandGlob(pattern, baseDir) {
  const files = [];

  const regexPattern = pattern
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .split('/')
    .map(part => {
      if (part === '<<GLOBSTAR>>') return '.*';
      if (part.includes('*')) {
        return part
          .replace(/\*\*/g, '.*')
          .replace(/(?<!\*)\*(?!\*)/g, '[^/]*');
      }
      return escapeRegExp(part);
    })
    .join('/');

  const regex = new RegExp(`^${regexPattern}$`);

  function walkDir(currentDir, relativePath = '') {
    if (!existsSync(currentDir)) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name);
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(entryPath, entryRelativePath);
      } else if (entry.isFile()) {
        if (regex.test(entryRelativePath)) {
          files.push(entryRelativePath);
        }
      }
    }
  }

  walkDir(baseDir);
  return files;
}

// ==================== Git SHA 追踪 ====================

function readSyncInfo(targetDir) {
  const syncInfoPath = join(targetDir, SYNC_INFO_FILE);
  if (existsSync(syncInfoPath)) {
    try {
      return JSON.parse(readFileSync(syncInfoPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

function writeSyncInfo(targetDir, info) {
  const syncInfoPath = join(targetDir, SYNC_INFO_FILE);
  writeFileSync(syncInfoPath, JSON.stringify(info, null, 2), 'utf-8');
}

function getGitCommitSha(dir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function getGitShortSha(dir) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function getGitCommitDate(dir) {
  try {
    return execSync('git log -1 --format=%ci', { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

// ==================== 模板版本读取 ====================

// 读取 package.json 中记录的模板版本（templateVersion 字段）
function readTemplateVersion(dir) {
  try {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.templateVersion || null;
  } catch {
    return null;
  }
}

// 对比本地与远程的模板版本，并输出差异提示
function compareTemplateVersion(localVersion, remoteVersion) {
  if (!localVersion && !remoteVersion) return; // 双方都没有版本字段，静默
  if (!remoteVersion) {
    logInfo('远程模板未包含 templateVersion 字段，无法对比模板版本');
    return;
  }
  if (!localVersion) {
    logInfo(`远程模板版本 (package.json): ${remoteVersion}`);
    return;
  }
  if (remoteVersion === localVersion) {
    logInfo(`模板版本 (package.json): 一致 (${remoteVersion})`);
  } else {
    logWarning(`模板版本差异 (package.json): ${localVersion} → ${remoteVersion}`);
  }
}

// ==================== 主函数 ====================

async function main() {
  const { flags, targetDir, localPath } = parseArgs();

  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  // 读取文件清单
  if (!existsSync(TEMPLATE_FILES_PATH)) {
    logError('找不到 template-files.json 文件');
    process.exit(1);
  }

  let templateFiles;
  try {
    templateFiles = JSON.parse(readFileSync(TEMPLATE_FILES_PATH, 'utf-8'));
  } catch (error) {
    logError(`解析 template-files.json 失败: ${error.message}`);
    process.exit(1);
  }

  // 从配置中读取仓库信息
  const repoConfig = templateFiles.repo || {};
  const REPO_URL = repoConfig.url || 'https://github.com/Sun-Panel/microapp-hello-world.git';
  const REPO_BRANCH = repoConfig.branch || 'main';

  logInfo('微应用模板更新工具');
  if (flags.dryRun) {
    logWarning('干运行模式：仅生成报告，不执行任何修改');
  }
  if (flags.local) {
    logInfo(`更新模式: 本地模式${localPath ? ` (${localPath})` : ''}`);
  } else {
    logInfo('更新模式: GitHub 模式');
  }
  logInfo(`执行模式: ${flags.force ? '强制覆盖' : '交互模式（展示 diff）'}`);
  logInfo(`目标目录: ${targetDir}`);

  // 读取当前项目的模板版本和同步信息
  const localTemplateFilesPath = join(targetDir, 'scripts', 'template-files.json');
  let localTemplateVersion = null;
  if (existsSync(localTemplateFilesPath)) {
    try {
      const localConfig = JSON.parse(readFileSync(localTemplateFilesPath, 'utf-8'));
      localTemplateVersion = localConfig.version || null;
    } catch {
      // 忽略解析错误
    }
  }
  if (localTemplateVersion) {
    logInfo(`当前模板版本: ${localTemplateVersion}`);
  } else {
    logInfo('当前模板版本: 未知（未找到 version 字段）');
  }

  // 读取 package.json 中记录的模板版本（templateVersion 字段）
  const localPkgTemplateVersion = readTemplateVersion(targetDir);
  if (localPkgTemplateVersion) {
    logInfo(`项目模板版本 (package.json): ${localPkgTemplateVersion}`);
  }

  // 读取上次同步的 commit 信息
  const syncInfo = readSyncInfo(targetDir);
  if (syncInfo) {
    logInfo(`上次同步: ${syncInfo.syncedAt || '未知时间'} (commit: ${syncInfo.commitShortSha || syncInfo.commitSha || '未知'})`);
  }

  if (!existsSync(targetDir)) {
    logError(`目标目录不存在: ${targetDir}`);
    process.exit(1);
  }

  // ---- 第 1 步：获取模板源码 ----
  let sourceDir;
  let tempDir = null;
  let remoteCommitSha = null;
  let remoteCommitShortSha = null;
  let remoteCommitDate = null;

  if (flags.local) {
    logStep('1. 使用本地模板目录');
    sourceDir = localPath || TEMPLATE_DIR;
    logInfo(`本地模板: ${sourceDir}`);
    remoteCommitSha = getGitCommitSha(sourceDir);
    remoteCommitShortSha = getGitShortSha(sourceDir);
    remoteCommitDate = getGitCommitDate(sourceDir);
    if (remoteCommitShortSha) {
      logInfo(`本地模板 commit: ${remoteCommitShortSha} (${remoteCommitDate || '未知时间'})`);
    }
    // 对比本地模板的 templateVersion
    compareTemplateVersion(localPkgTemplateVersion, readTemplateVersion(sourceDir));
  } else {
    logStep('1. 从 GitHub 拉取模板最新代码');

    try {
      execSync('git --version', { stdio: 'ignore' });
    } catch {
      logError('未找到 git 命令，请先安装 git');
      process.exit(1);
    }

    tempDir = join(tmpdir(), `microapp-template-update-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    logInfo(`仓库: ${REPO_URL}`);
    logInfo(`分支: ${REPO_BRANCH}`);

    try {
      logInfo('正在克隆仓库...');
      execSync(`git clone --depth 50 --branch ${REPO_BRANCH} ${REPO_URL} ${tempDir}`, {
        stdio: 'pipe',
      });

      // 在删除 .git 之前获取 commit 信息
      remoteCommitSha = getGitCommitSha(tempDir);
      remoteCommitShortSha = getGitShortSha(tempDir);
      remoteCommitDate = getGitCommitDate(tempDir);

      const gitDir = join(tempDir, '.git');
      if (existsSync(gitDir)) {
        rmSync(gitDir, { recursive: true, force: true });
      }

      sourceDir = tempDir;
      logSuccess('成功拉取模板最新代码');

      if (remoteCommitShortSha) {
        logInfo(`远程 commit: ${remoteCommitShortSha} (${remoteCommitDate || '未知时间'})`);
      }

      // 对比上次同步的 commit
      if (syncInfo && syncInfo.commitSha && remoteCommitSha) {
        if (syncInfo.commitSha === remoteCommitSha) {
          logInfo('版本状态: 已是最新版本（commit 相同）');
        } else {
          logWarning(`模板有新提交: ${syncInfo.commitShortSha || syncInfo.commitSha.slice(0, 7)} → ${remoteCommitShortSha}`);
        }
      }

      // 读取远程模板版本并对比
      const remoteTemplatePath = join(tempDir, 'scripts', 'template-files.json');
      if (existsSync(remoteTemplatePath)) {
        try {
          const remoteConfig = JSON.parse(readFileSync(remoteTemplatePath, 'utf-8'));
          const remoteVersion = remoteConfig.version;
          if (remoteVersion) {
            logInfo(`远程模板版本: ${remoteVersion}`);
            if (localTemplateVersion) {
              if (remoteVersion === localTemplateVersion) {
                logInfo('版本号: 一致');
              } else {
                logWarning(`版本差异: ${localTemplateVersion} → ${remoteVersion}`);
              }
            }
          }
        } catch {
          // 忽略版本解析错误
        }
      }

      // 读取远程 package.json 的 templateVersion 并对比
      compareTemplateVersion(localPkgTemplateVersion, readTemplateVersion(tempDir));
    } catch (cloneError) {
      logError(`克隆仓库失败`);
      const stderrMsg = cloneError.stderr
        ? cloneError.stderr.toString().trim()
        : '';
      const stdoutMsg = cloneError.stdout
        ? cloneError.stdout.toString().trim()
        : '';
      const detail = stderrMsg || stdoutMsg || cloneError.message;
      logError(`错误详情: ${detail}`);
      logInfo('可能原因：');
      logInfo('  - 网络连接问题（请检查网络代理设置）');
      logInfo('  - 仓库不存在或分支名错误（当前分支: ' + REPO_BRANCH + '）');
      logInfo('  - GitHub 访问受限（可配置代理或使用 --local 模式）');
      logInfo('提示：使用 --local 模式可跳过网络拉取，直接使用本地模板');
      process.exit(1);
    }
  }

  // ---- 第 2 步：逐文件对比，展示 diff ----
  const filesToSync = [];
  const syncedPaths = new Set();

  for (const fileInfo of templateFiles.files) {
    // 处理通配符模式
    if (fileInfo.glob) {
      const matchedPaths = expandGlob(fileInfo.path, sourceDir);
      for (const matchedPath of matchedPaths) {
        const matchedFileInfo = { ...fileInfo, path: matchedPath, glob: false };
        const sourcePath = join(sourceDir, matchedPath);
        const targetPath = join(targetDir, matchedPath);

        if (!existsSync(sourcePath)) {
          continue;
        }

        if (!existsSync(targetPath)) {
          filesToSync.push({ fileInfo: matchedFileInfo, sourcePath, targetPath, diffs: [{ type: 'added', line: 1, content: '(新文件)' }] });
          continue;
        }

        const diffs = computeDiff(sourcePath, targetPath);

        if (matchedFileInfo.overwriteIfUnchanged) {
          if (sourcePath === targetPath) {
            continue;
          }
          if (diffs.length > 0) {
            filesToSync.push({ fileInfo: matchedFileInfo, sourcePath, targetPath, diffs });
            syncedPaths.add(matchedPath);
          }
          continue;
        }

        if (diffs.length > 0) {
          filesToSync.push({ fileInfo: matchedFileInfo, sourcePath, targetPath, diffs });
          syncedPaths.add(matchedPath);
        }
      }
      continue;
    }

    const sourcePath = join(sourceDir, fileInfo.path);
    const targetPath = join(targetDir, fileInfo.path);

    if (!existsSync(sourcePath)) {
      continue;
    }

    // 去重：单独定义的条目优先于通配符匹配
    if (syncedPaths.has(fileInfo.path)) {
      const idx = filesToSync.findIndex(f => f.fileInfo.path === fileInfo.path);
      if (idx !== -1) {
        filesToSync.splice(idx, 1);
      }
    }

    // package.json 使用合并策略，总是需要更新
    if (fileInfo.path === 'package.json' && fileInfo.mergeStrategy === 'shallow') {
      filesToSync.push({ fileInfo, sourcePath, targetPath, diffs: [] });
      syncedPaths.add(fileInfo.path);
      continue;
    }

    if (!existsSync(targetPath)) {
      filesToSync.push({ fileInfo, sourcePath, targetPath, diffs: [{ type: 'added', line: 1, content: '(新文件)' }] });
      syncedPaths.add(fileInfo.path);
      continue;
    }

    const diffs = computeDiff(sourcePath, targetPath);

    if (fileInfo.overwriteIfUnchanged) {
      if (sourcePath === targetPath) {
        continue;
      }
      if (diffs.length > 0) {
        filesToSync.push({
          fileInfo,
          sourcePath,
          targetPath,
          diffs
        });
        syncedPaths.add(fileInfo.path);
      }
      continue;
    }

    if (diffs.length > 0) {
      filesToSync.push({ fileInfo, sourcePath, targetPath, diffs });
      syncedPaths.add(fileInfo.path);
    }
  }

  // ---- 干运行模式：生成报告并退出 ----
  if (flags.dryRun) {
    logStep('干运行报告');

    if (filesToSync.length === 0) {
      logInfo('所有文件已是最新版本，无需更新');
      return;
    }

    const newFiles = filesToSync.filter(f => f.diffs.length === 1 && f.diffs[0].content === '(新文件)');
    const updatedFiles = filesToSync.filter(f => f.diffs.length > 0 && !(f.diffs.length === 1 && f.diffs[0].content === '(新文件)'));
    const mergeFiles = filesToSync.filter(f => f.diffs.length === 0);

    logInfo(`总计 ${filesToSync.length} 个文件需要处理：`);

    if (newFiles.length > 0) {
      log(colors.green, `\n  📥 新增文件 (${newFiles.length}):`);
      for (const { fileInfo } of newFiles) {
        logDry(`${fileInfo.path}`);
      }
    }

    if (updatedFiles.length > 0) {
      log(colors.yellow, `\n  📝 需要更新 (${updatedFiles.length}):`);
      for (const { fileInfo, diffs } of updatedFiles) {
        logDry(`${fileInfo.path} (${diffs.length} 处变更)`);
      }
    }

    if (mergeFiles.length > 0) {
      log(colors.cyan, `\n  🔀 需要合并 (${mergeFiles.length}):`);
      for (const { fileInfo } of mergeFiles) {
        logDry(`${fileInfo.path} (保留项目特有配置)`);
      }
    }

    // 检查需要清理的废弃文件
    const dryCleanupList = templateFiles.cleanup || [];
    const dryCleanupExist = dryCleanupList.filter(p => existsSync(join(targetDir, p)));
    if (dryCleanupExist.length > 0) {
      log(colors.yellow, `\n  🧹 需要清理的废弃文件 (${dryCleanupExist.length}):`);
      for (const p of dryCleanupExist) {
        logDry(p);
      }
    }

    // 检查冲突文件
    let conflictCount = 0;
    for (const item of filesToSync) {
      if (item.fileInfo.path === 'package.json' && item.fileInfo.mergeStrategy === 'shallow') continue;
      if (!existsSync(item.targetPath)) continue;
      if (item.fileInfo.overwriteIfUnchanged) continue;
      try {
        execSync(`git diff --quiet HEAD -- "${item.fileInfo.path}"`, { cwd: targetDir, stdio: 'pipe' });
      } catch {
        conflictCount++;
      }
    }

    if (conflictCount > 0) {
      logWarning(`其中 ${conflictCount} 个文件有本地修改，更新时需要处理冲突`);
    }

    // 显示版本追踪信息
    if (remoteCommitShortSha && syncInfo && syncInfo.commitSha) {
      if (syncInfo.commitSha === remoteCommitSha) {
        logInfo(`同步状态: 已是最新 (commit: ${remoteCommitShortSha})`);
      } else {
        logWarning(`同步状态: 需要更新 (${syncInfo.commitShortSha || '?'} → ${remoteCommitShortSha})`);
      }
    } else if (remoteCommitShortSha) {
      logInfo(`远程 commit: ${remoteCommitShortSha}`);
    }

    log(colors.bold, `\n📋 干运行完成，未修改任何文件`);
    logInfo('去掉 --dry-run 参数即可执行实际更新');
    return;
  }

  // ---- 非强制模式：展示 diff ----
  if (filesToSync.length === 0) {
    logStep('结果');
    logInfo('所有文件已是最新版本，无需更新');
    return;
  }

  if (!flags.force) {
    logStep('2. 变更预览');

    // 显示模板版本变化（package.json 走 merge 策略，行级 diff 中不可见）
    const remotePkgTemplateVersion = readTemplateVersion(sourceDir);
    if (remotePkgTemplateVersion && localPkgTemplateVersion && remotePkgTemplateVersion !== localPkgTemplateVersion) {
      logWarning(`模板版本将更新: ${localPkgTemplateVersion} → ${remotePkgTemplateVersion}`);
    }

    const changedFiles = filesToSync.filter(f => f.diffs.length > 0);
    const newMerges = filesToSync.filter(f => f.diffs.length === 0 && !f.fileInfo.overwriteIfUnchanged);

    if (changedFiles.length > 0) {
      logInfo(`以下 ${changedFiles.length} 个文件有变更：\n`);
      for (const { fileInfo, diffs } of changedFiles) {
        showDiff(fileInfo.path, diffs);
        console.log();
      }
    }

    if (newMerges.length > 0) {
      logInfo(`以下 ${newMerges.length} 个文件将执行合并策略（保留项目特有配置）：`);
      for (const { fileInfo } of newMerges) {
        logInfo(`  - ${fileInfo.path}`);
      }
      console.log();
    }

    const confirmed = await askConfirm(
      `确认更新以上 ${filesToSync.length} 个文件？`
    );

    if (!confirmed) {
      logInfo('已取消更新');
      return;
    }
  } else {
    logStep('2. 强制更新');
    logInfo(`将更新 ${filesToSync.length} 个文件（跳过 diff 展示）`);
  }

  // ---- 第 3 步：执行更新 ----
  logStep('3. 执行更新');

  // 检查工作区是否干净
  let needStashPop = false;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: targetDir, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: targetDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (status && !flags.force) {
      logWarning('检测到未提交的更改,请先手动提交修改的文件(推荐),或继续 (Y) 自动执行保存到 git stash!');
      const shouldStash = await askConfirm('是否自动执行 "git stash push" 保存修改？（更新完成后需手动执行 "git stash pop" 恢复）');
      if (shouldStash) {
        logInfo('正在执行 git stash push...');
        execSync('git stash push -m "auto-stash before template update"', { cwd: targetDir, stdio: 'pipe' });
        logSuccess('已保存修改到 git stash');
        needStashPop = true;
      } else {
        logInfo('已取消更新。您可以先手动提交或暂存更改后再更新。');
        process.exit(0);
      }
    } else if (status && flags.force) {
      logInfo('强制模式：跳过工作区检查');
    } else {
      logInfo('工作区干净，继续更新');
    }
  } catch {
    // 非 git 仓库，跳过检查
  }

  let updatedCount = 0;
  let skippedCount = 0;
  let conflictKeepCount = 0;
  let errorCount = 0;
  let skipAllConflicts = false;

  for (const { fileInfo, sourcePath, targetPath } of filesToSync) {
    const targetDirPath = join(targetDir, fileInfo.path, '..');
    if (!existsSync(targetDirPath)) {
      mkdirSync(targetDirPath, { recursive: true });
    }

    // package.json 合并策略
    if (fileInfo.path === 'package.json' && fileInfo.mergeStrategy === 'shallow') {
      try {
        const sourceContent = JSON.parse(readFileSync(sourcePath, 'utf-8'));
        let targetContent = {};

        if (existsSync(targetPath)) {
          targetContent = JSON.parse(readFileSync(targetPath, 'utf-8'));
        }

        const preservedFields = fileInfo.skipFields || [];

        // 先处理需要保留的字段（skipFields）：完全不触碰，保留目标项目的值
        // 然后处理需要合并的字段（deps 类）：双方取并集
        // 最后处理剩余字段：直接用模板值覆盖
        const mergeFields = ['dependencies', 'devDependencies', 'scripts'];

        for (const [key, value] of Object.entries(sourceContent)) {
          if (preservedFields.includes(key)) {
            // skipFields 中的字段：完全保留目标项目原值，不做任何修改
            continue;
          }
          if (mergeFields.includes(key) && typeof value === 'object' && value !== null) {
            // 合并字段：双方取并集，模板有的取模板值，目标独有的保留
            targetContent[key] = {
              ...targetContent[key],
              ...value,
            };
          } else {
            // 普通字段：直接用模板值覆盖
            targetContent[key] = value;
          }
        }

        writeFileSync(targetPath, JSON.stringify(targetContent, null, 2) + '\n', 'utf-8');
        logSuccess(`${fileInfo.path}（合并策略）`);
        updatedCount++;
      } catch (error) {
        logError(`${fileInfo.path} 更新失败: ${error.message}`);
        errorCount++;
      }
      continue;
    }

    // 普通文件
    try {
      if (sourcePath === targetPath) {
        logInfo(`${fileInfo.path} 源路径和目标路径相同，跳过复制`);
        skippedCount++;
        continue;
      }

      // 冲突检测：检查目标文件是否已被本地修改（包括 staged changes）
      let locallyModified = false;
      if (existsSync(targetPath) && !fileInfo.overwriteIfUnchanged) {
        try {
          execSync(`git diff --quiet HEAD -- "${fileInfo.path}"`, { cwd: targetDir, stdio: 'pipe' });
        } catch {
          locallyModified = true;
        }
      }

      if (locallyModified) {
        if (skipAllConflicts) {
          logInfo(`${fileInfo.path} 跳过（用户选择了跳过全部冲突文件）`);
          conflictKeepCount++;
          continue;
        }

        // 交互模式下让用户选择
        if (!flags.force) {
          const choice = await askConflictChoice(fileInfo.path);

          switch (choice) {
            case 'keep':
              logInfo(`${fileInfo.path} 保留本地修改，跳过更新`);
              conflictKeepCount++;
              continue;
            case 'skipAll':
              logWarning('跳过全部剩余冲突文件');
              skipAllConflicts = true;
              conflictKeepCount++;
              continue;
            case 'overwrite':
            default:
              logWarning(`${fileInfo.path} 将被模板版本覆盖`);
              break;
          }
        } else {
          // 强制模式：直接覆盖，只给出警告
          logWarning(`${fileInfo.path} 已被本地修改，将被模板版本覆盖`);
        }
      }

      cpSync(sourcePath, targetPath, { force: true });
      logSuccess(fileInfo.path);
      updatedCount++;
    } catch (error) {
      logError(`${fileInfo.path} 更新失败: ${error.message}`);
      errorCount++;
    }
  }

  // ---- 第 4 步：清理废弃文件 ----
  const cleanupList = templateFiles.cleanup || [];
  let cleanedCount = 0;

  if (cleanupList.length > 0) {
    logStep('4. 清理废弃文件');

    for (const cleanupPath of cleanupList) {
      const fullPath = join(targetDir, cleanupPath);
      if (!existsSync(fullPath)) {
        continue;
      }

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          rmSync(fullPath, { recursive: true, force: true });
          logSuccess(`已删除废弃目录: ${cleanupPath}`);
          cleanedCount++;
        } else if (stat.isFile()) {
          unlinkSync(fullPath);
          logSuccess(`已删除废弃文件: ${cleanupPath}`);
          cleanedCount++;
        }
      } catch (error) {
        logWarning(`清理 ${cleanupPath} 失败: ${error.message}`);
      }
    }

    if (cleanedCount === 0) {
      logInfo('无需清理的废弃文件');
    }
  }

  // ---- 第 5 步：写入同步信息 ----
  if (remoteCommitSha && updatedCount > 0) {
    try {
      const newSyncInfo = {
        commitSha: remoteCommitSha,
        commitShortSha: remoteCommitShortSha,
        commitDate: remoteCommitDate,
        syncedAt: new Date().toISOString(),
        version: localTemplateVersion || null,
        remoteVersion: null,
        templateVersion: readTemplateVersion(targetDir),
      };

      // 读取远程版本号
      const remoteTemplatePath = sourceDir && join(sourceDir, 'scripts', 'template-files.json');
      if (remoteTemplatePath && existsSync(remoteTemplatePath)) {
        try {
          const remoteConfig = JSON.parse(readFileSync(remoteTemplatePath, 'utf-8'));
          newSyncInfo.remoteVersion = remoteConfig.version || null;
        } catch {
          // 忽略
        }
      }

      writeSyncInfo(targetDir, newSyncInfo);
      logInfo(`同步信息已写入 ${SYNC_INFO_FILE}`);
    } catch {
      // 忽略写入错误
    }
  }

  // ---- 第 6 步：报告 ----
  logStep('6. 完成');

  logInfo(`成功: ${updatedCount} 个文件 | 跳过: ${skippedCount} 个文件 | 保留: ${conflictKeepCount} 个文件 | 清理: ${cleanedCount} 个文件 | 失败: ${errorCount} 个文件`);

  if (errorCount > 0) {
    logWarning('部分文件更新失败，请检查错误信息');
  }

  if (updatedCount > 0) {
    logSuccess('模板更新完成！');
    // 打印更新后的模板版本
    const updatedTemplateVersion = readTemplateVersion(targetDir);
    if (updatedTemplateVersion) {
      logInfo(`当前模板版本 (package.json): ${updatedTemplateVersion}`);
    }
    if (remoteCommitShortSha) {
      logInfo(`已同步至 commit: ${remoteCommitShortSha} (${remoteCommitDate || ''})`);
    }
    logInfo('建议操作:');
    logInfo('  1. 运行 npm install 安装新依赖（如有）');
    logInfo('  2. 运行 npm run dev 测试功能');
    logInfo('  3. 运行 git diff 检查变更内容');
    if (needStashPop) {
      logInfo(`  4. 运行 ${colors.bold}git stash pop${colors.reset} 恢复之前暂存的修改`);
    }
  } else if (needStashPop) {
    logWarning('模板无变化，但存在暂存的修改需要恢复：');
    logInfo(`运行 ${colors.bold}git stash pop${colors.reset} 恢复之前暂存的修改`);
  }

  // 清理临时目录
  if (tempDir && existsSync(tempDir)) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  }
}

// 运行
main().catch(error => {
  logError(`程序异常: ${error.message}`);
  process.exit(1);
});
