s=open('app.src.html').read()
s=s.replace('/*ASSETS*/',open('assets.js').read()).replace('/*ENGINE*/',open('engine.js').read())
open('ai-discovery-world.html','w').write(s); print(len(s)//1024,'KB')
