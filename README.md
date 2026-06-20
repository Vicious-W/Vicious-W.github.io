# Vicious-W.github.io

一个使用原生 HTML、CSS 和 JavaScript 编写的个人静态主页，可直接部署到 GitHub Pages。

## 页面内容

- 个人欢迎页与学习目录
- 本地背景图片和背景音乐
- 导航图片展示
- 鼠标跟随头像、点击爱心等页面特效
- CSDN、QQ 和邮箱联系方式

## 项目结构

```text
.
├── index.html       # 页面结构与交互脚本
├── style.css        # 页面样式
├── *.jpg / *.png    # 背景、头像和图标素材
└── *.mp3            # 音乐素材
```

## 本地预览

项目没有额外依赖或构建步骤，可以直接用浏览器打开 `index.html`。也可以在项目目录启动一个本地服务器：

```bash
python3 -m http.server 8000
```

然后访问 <http://localhost:8000>。

## 在线地址

<https://vicious-w.github.io/>
