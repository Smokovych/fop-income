"""Збирає один HTML-файл: python3 standalone/build.py → dist/ФОП-дохід.html"""
import os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
html = open(os.path.join(here, "template.html"), encoding="utf-8").read()
css = open(os.path.join(root, "static", "styles.css"), encoding="utf-8").read()
# порядок важливий: remote.js використовує randomKey() з privat.js, app.js — SERVER_MODE з remote.js
js = "\n".join(open(os.path.join(here, n), encoding="utf-8").read() for n in ("commission.js", "privat.js", "remote.js", "tax.js", "app.js"))
html = html.replace("/*CSS*/", css).replace("<script>/*JS*/</script>", "<script>\n" + js.replace("</script", "<\\/script") + "\n</script>")
os.makedirs(os.path.join(root, "dist"), exist_ok=True)
out = os.path.join(root, "dist", "ФОП-дохід.html")
open(out, "w", encoding="utf-8").write(html)
print(out, len(html))

# копія для GitHub Pages
os.makedirs(os.path.join(root, "docs"), exist_ok=True)
open(os.path.join(root, "docs", "index.html"), "w", encoding="utf-8").write(html)
