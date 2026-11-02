// registry.js —— 型号注册表与按需加载器（由 kbini_to_json.py 生成，勿手改）
window.LEOBOG_REGISTRY = {
  files: {
  "2": "data/models/2.js",
  "A75": "data/models/a75.js",
  "Hi75C Pro": "data/models/hi75c-pro.js",
  "Hi8": "data/models/hi8.js",
  "Hi86": "data/models/hi86.js",
  "Hi8SE": "data/models/hi8se.js",
  "Hi98": "data/models/hi98.js",
  "Hi98 3-Mode": "data/models/hi98-3-mode.js",
  "RGB": "data/models/rgb.js"
},
  psdMap: {
  "03:00:00:00:00:a2": "2",
  "03:00:00:00:00:65": "A75",
  "03:00:00:00:00:a3": "Hi75C Pro",
  "03:00:00:00:00:ca": "Hi8",
  "03:00:00:00:01:8d": "Hi86",
  "03:00:00:00:01:3f": "Hi8SE",
  "03:00:00:00:01:22": "Hi98",
  "03:00:00:00:01:21": "Hi98 3-Mode",
  "03:00:00:00:00:9b": "RGB"
}
};
window.LEOBOG_MODELS = {};
window.LEOBOG_loadModel = function (name) {
  return new Promise(function (res, rej) {
    if (window.LEOBOG_MODELS[name]) return res(window.LEOBOG_MODELS[name]);
    var src = window.LEOBOG_REGISTRY.files[name];
    if (!src) return rej(new Error('未知型号: ' + name));
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () {
      window.LEOBOG_MODELS[name] ? res(window.LEOBOG_MODELS[name])
        : rej(new Error('型号数据加载失败: ' + name));
    };
    s.onerror = function () { rej(new Error('型号文件不存在: ' + src)); };
    document.head.appendChild(s);
  });
};
