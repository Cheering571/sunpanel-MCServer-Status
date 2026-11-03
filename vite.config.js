/**
 * Vite 配置文件
 */

import { defineConfig } from 'vite';
import eslintPlugin from 'vite-plugin-eslint';
import { resolve } from 'path';
import { existsSync } from 'fs';

/**
 * 判断是否为测试模式（NODE_ENV=development 标识）
 * 同时服务于开发服务器（npm run dev）和测试打包（npm run pack:test）
 */
const isDev = process.env.NODE_ENV === 'development';

/**
 * locales JSON 代理插件
 * 开发模式下，将 /locales/xx.json 请求代理到 locales/xx.js 源文件
 * 这样浏览器可以直接访问 JSON 语言文件
 */
function localesJsonProxy() {
  return {
    name: 'locales-json-proxy',
    configureServer(server) {
      server.middlewares.use('/locales', async (req, res, next) => {
        const url = req.url;
        // 只拦截 .json 请求
        if (!url || !url.endsWith('.json')) {
          return next();
        }

        // 从 URL 提取语言代码，如 /locales/zh-CN.json -> zh-CN
        const locale = url.replace(/^\//, '').replace('.json', '');
        const jsPath = resolve(process.cwd(), 'locales', `${locale}.js`);

        // 文件不存在时交给下一个中间件（返回 404 或 SPA fallback）
        if (!existsSync(jsPath)) {
          return next();
        }

        try {
          const mod = await server.ssrLoadModule(`/locales/${locale}.js`);
          const data = mod.default || mod;

          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(data, null, 2));
        } catch (error) {
          console.error(`[locales-json-proxy] Failed to load ${locale}.js:`, error.message);
          next();
        }
      });
    }
  };
}

/**
 * Locales 编译插件
 * 在 Vite 构建完成后，将 locales/ 目录下的 .js 翻译文件编译为 .json 并输出到 dist/locales/
 * 必须在 writeBundle 钩子中执行，否则 emptyOutDir 会清空编译结果
 */
function compileLocalesPlugin() {
  return {
    name: 'compile-locales',
    enforce: 'post',
    async writeBundle() {
      const { compileLocales } = await import('./build/generators/locales-generator.js');
      compileLocales();
    }
  };
}

/**
 * 强制完全压缩插件
 * 解决 Vite 5 lib 模式下 minify: 'esbuild' 不完全压缩的问题
 * 通过 generateBundle 钩子在最终输出阶段进行完整压缩
 */
function forceMinifyPlugin() {
  return {
    name: 'force-minify',
    enforce: 'post',
    async generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && fileName.endsWith('.js')) {
          const esbuild = await import('esbuild');
          let result = await esbuild.transform(chunk.code, {
            minify: true,
            legalComments: 'none',
            target: 'es2020',
            format: 'esm',
            treeShaking: true,
          });
          // 将模板字符串内的真实换行替换为 \n 转义序列，进一步压缩到单行
          // esbuild 压缩后，仅模板字符串内保留真实换行，直接全局替换即可
          // 先 trim 掉尾部换行（模板字符串外的换行），避免替换后变成无效的字面 \n
          chunk.code = result.code.trimEnd().replace(/\n/g, '\\n');
        }
      }
    }
  };
}
export default defineConfig(async () => {
  // 构建前钩子 - 生成配置文件
  if (!isDev) {
    console.log('📋 生成配置文件...');
    const { spawn } = await import('child_process');
    await new Promise((resolve, reject) => {
      const buildProcess = spawn('node', ['build/build.js', '--yes'], {
        cwd: process.cwd(),
        stdio: 'inherit'
      });
      buildProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`构建脚本退出码: ${code}`));
        }
      });
    });
  }

  return {
    root: '.',
    publicDir: 'public',
    // compileLocalesPlugin 在 dev 构建时也必须启用，否则 dist/locales/*.json 不会生成，
    // 导致打包出的 zip 缺少主应用解析 $t:APP_NAME 等翻译所需的语言文件
    plugins: isDev
      ? [eslintPlugin(), localesJsonProxy(), compileLocalesPlugin()]
      : [forceMinifyPlugin(), compileLocalesPlugin()],

    esbuild: {
      // 移除所有注释，确保完全压缩
      legalComments: 'none',
    },

    server: {
      host: '0.0.0.0',
      port: 3000,
      open: true,
      // 允许所有域名跨域访问
      cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        credentials: true,
      },
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      minify: false,
      sourcemap: isDev,
      lib: {
        entry: 'src/main.js',
        name: 'MicroApp',
        formats: ['es'],
        fileName: () => 'main.js'
      },
      rollupOptions: {
        output: {
          assetFileNames: 'assets/[name].[hash][extname]',
          chunkFileNames: 'assets/[name].[hash].js',
        }
      }
    },

    optimizeDeps: {
      exclude: []
    }
  };
});
