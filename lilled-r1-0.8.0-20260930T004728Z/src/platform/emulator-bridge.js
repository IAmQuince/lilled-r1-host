// Cross-origin bridge shim documented by Boondit's R1 emulator guidance.
// It is intentionally inert on a top-level page / physical R1 WebView.
(function () {
  if (window.parent === window) return;
  const EVENTS = ['scrollUp', 'scrollDown', 'sideClick', 'longPressStart', 'longPressEnd'];
  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || data.__r1emu !== true) return;
    if (data.type === 'event' && EVENTS.includes(data.event)) {
      window.dispatchEvent(new CustomEvent(data.event, { detail: data.detail }));
    } else if (data.type === 'pluginMessage' && typeof window.onPluginMessage === 'function') {
      window.onPluginMessage(data.payload);
    }
  });
  function relay(name) {
    return { postMessage(message) { window.parent.postMessage({ __r1emu: true, type: 'outbound', channel: name, msg: message }, '*'); } };
  }
  if (!window.PluginMessageHandler) window.PluginMessageHandler = relay('PluginMessageHandler');
  if (!window.CreationVoiceHandler) window.CreationVoiceHandler = relay('CreationVoiceHandler');
  if (!window.closeWebView) window.closeWebView = relay('closeWebView');
})();
