/**
 * 组件配置文件
 * 类似于 vue 路由配置，name 值全局不可以重复
 */

import { McCard } from '../src/components/card.js';
import { McCardConfig } from '../src/components/config.js';

export default {
  // =======================
  // 页面注册
  // =======================
  pages: {
    // 卡片配置页（添加 / 编辑卡片时以窗口形式打开）
    'mcserver-config': {
      component: McCardConfig,
      background: '#1a1a1a',
      backgroundDark: '#141414',
      headerTextColor: '#55ff55',
      headerTextColorDark: '#55ff55',
    },
  },

  // =======================
  // 小部件（卡片）注册
  // =======================
  widgets: {
    'MCServer-Status': {
      component: McCard,
      configComponentName: 'mcserver-config',
      // 只保留这四种：整行 / 宽条 / 方形 / 超宽
      size: ['1xfull', '2x4', '2x2', '1x2'],
      background: '',
      widgetName: '$t:WIDGET_NAME',
      widgetDescription: '$t:WIDGET_DESCRIPTION',
      sort: 10,
    },
  },
};
