'use strict';
/**
 * 预加载脚本：通过 contextBridge 向渲染进程安全暴露 API。
 * 渲染进程只能调用 api.call(channel, arg) 与订阅事件，无法直接访问 Node。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** 调用主进程方法，返回 Promise */
  call(channel, arg) {
    return ipcRenderer.invoke(channel, arg);
  },
  /** 订阅主进程推送的事件（progress / done / install 等），返回取消订阅函数 */
  onEvent(cb) {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('event', handler);
    return () => ipcRenderer.removeListener('event', handler);
  },
});
