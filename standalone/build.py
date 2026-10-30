"""Збирає один HTML-файл: python3 standalone/build.py → dist/ФОП-дохід.html"""
import os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
html = open(os.path.join(here, "template.html"), encoding="utf-8").read()
css = open(os.path.join(root, "static", "styles.css"), encoding="utf-8").read()
js = open(os.path.join(here, "commission.js"), encoding="utf-8").read() + "\n" + open(os.path.join(here, "privat.js"), encoding="utf-8").read() + "\n" + open(os.path.join(here, "app.js"), encoding="utf-8").read()
html = html.replace("/*CSS*/", css).replace("<script>/*JS*/</script>", "<script>\n" + js.replace("</script", "<\\/script") + "\n</script>")
os.makedirs(os.path.join(root, "dist"), exist_ok=True)
out = os.path.join(root, "dist", "ФОП-дохід.html")
open(out, "w", encoding="utf-8").write(html)
print(out, len(html))

# копія для GitHub Pages
os.makedirs(os.path.join(root, "docs"), exist_ok=True)
open(os.path.join(root, "docs", "index.html"), "w", encoding="utf-8").write(html)
