import sys
P=30; Y0=150
X={'a':330,'b':362,'c':394,'d':426,'e':458,'f':532,'g':564,'h':596,'i':628,'j':660}
LM,LP,RP,RM=250,280,710,740   # left -, left +, right +, right -
def y(r): return Y0+(r-1)*P
o=[]; A=o.append
A('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff}</style></head><body>')
A('<svg width="1560" height="1180" viewBox="0 0 1560 1180" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica,Arial,sans-serif">')
A('<rect width="1560" height="1180" fill="#fafafa"/>')
def T(x,yy,t,c="#111",anc="middle",fs=14,w=700): A(f'<text x="{x}" y="{yy}" font-size="{fs}" font-weight="{w}" fill="{c}" text-anchor="{anc}">{t}</text>')
T(40,50,"Clarity main breadboard (as built)","#111","start",28)
T(40,80,"Hold the board with row 1 at the TOP and column a on the LEFT. Match rails by COLOR (red line = +, blue line = −), not by position. Dashed = soldered LDR leads.","#555","start",15,400)
A(f'<rect x="215" y="{y(1)-40}" width="560" height="{29*P+80}" rx="12" fill="#f3efe6" stroke="#bbb" stroke-width="2"/>')
A(f'<rect x="488" y="{y(1)-30}" width="20" height="{29*P+60}" fill="#e2ddd2"/>')
for c,x in X.items(): T(x,y(1)-18,c,"#555",fs=15)
for x,c,s in ((LM,"#2563eb","−"),(LP,"#dc2626","+"),(RP,"#dc2626","+"),(RM,"#2563eb","−")):
    T(x,y(1)-18,s,c,fs=20); A(f'<line x1="{x+12}" y1="{y(1)-8}" x2="{x+12}" y2="{y(30)+8}" stroke="{c}" stroke-width="2"/>')
for r in range(1,31):
    T(305,y(r)+5,str(r),"#999",fs=11,w=400); T(685,y(r)+5,str(r),"#999",fs=11,w=400)
    for x in list(X.values())+[LM,LP,RP,RM]: A(f'<rect x="{x-4}" y="{y(r)-4}" width="8" height="8" fill="#9ca3af"/>')
def ring(x,yy,c): A(f'<circle cx="{x}" cy="{yy}" r="9" fill="none" stroke="{c}" stroke-width="3"/>')
def res(x1,y1,x2,y2,lab,col="#e9d5a8"):
    A(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#777" stroke-width="3"/>')
    mx,my=(x1+x2)/2,(y1+y2)/2
    if y1==y2: A(f'<rect x="{mx-20}" y="{my-8}" width="40" height="16" rx="6" fill="{col}" stroke="#a16207"/>')
    else: A(f'<rect x="{mx-8}" y="{my-20}" width="16" height="40" rx="6" fill="{col}" stroke="#a16207"/>')
    ring(x1,y1,"#a16207"); ring(x2,y2,"#a16207"); T(mx,my-14 if y1==y2 else my+4,lab,"#7c2d12",fs=12)
def tag(x,yy,t,c,side):  # wire stub to off-board
    x2 = x-120 if side=="L" else x+70
    if side=="L" and x<300: x2=x-70
    A(f'<line x1="{x}" y1="{yy}" x2="{x2}" y2="{yy}" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'); ring(x,yy,c)
    w=len(t)*7.6+14; bx = x2-w if side=="L" else x2
    A(f'<rect x="{bx}" y="{yy-12}" width="{w}" height="24" rx="6" fill="{c}"/>'); T(bx+w/2,yy+5,t,"#fff",fs=12.5)
def jump(x1,y1,x2,y2,c):
    A(f'<path d="M{x1},{y1} C{x1},{y1+40} {x2},{y2+40} {x2},{y2}" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'); ring(x1,y1,c); ring(x2,y2,c)
def later(x,yy,t):
    A(f'<circle cx="{x}" cy="{yy}" r="9" fill="none" stroke="#999" stroke-width="2" stroke-dasharray="3 3"/>')

def wire(pts,c,w=5,dash=""):
    d="M"+" L".join(f"{a},{b}" for a,b in pts); A(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round" {dash}/>')
def tagR(x,yy,t,c,x2=RM+60,dash=""):
    wire([(x,yy),(x2,yy)],c,dash=dash); ring(x,yy,c)
    w=len(t)*7.3+14; A(f'<rect x="{x2}" y="{yy-12}" width="{w}" height="24" rx="6" fill="{c}"/>'); T(x2+w/2,yy+5,t,"#fff",fs=12.5)
def tagL(x,yy,t,c,x2=None,dash=""):
    x2 = x2 if x2 else (x-70 if x<300 else 200)
    wire([(x,yy),(x2,yy)],c,dash=dash); ring(x,yy,c)
    w=len(t)*7.3+14; A(f'<rect x="{x2-w}" y="{yy-12}" width="{w}" height="24" rx="6" fill="{c}"/>'); T(x2-w/2,yy+5,t,"#fff",fs=12.5)
def arc(x1,y1,x2,y2,c,b=30):
    A(f'<path d="M{x1},{y1} C{x1},{y1+b} {x2},{y2+b} {x2},{y2}" fill="none" stroke="{c}" stroke-width="5" stroke-linecap="round"/>'); ring(x1,y1,c); ring(x2,y2,c)
# rails power
tagL(LP,y(1),"Uno 5V","#dc2626",x2=LP-70); tagL(LM,y(2),"Uno GND","#111",x2=LM-40)
A(f'<path d="M{LP},{y(30)} C{LP},{y(30)+60} {RP},{y(30)+60} {RP},{y(30)}" fill="none" stroke="#dc2626" stroke-width="5"/>'); ring(LP,y(30),"#dc2626"); ring(RP,y(30),"#dc2626")
A(f'<path d="M{LM},{y(30)} C{LM},{y(30)+90} {RM},{y(30)+90} {RM},{y(30)}" fill="none" stroke="#111" stroke-width="5"/>'); ring(LM,y(30),"#111"); ring(RM,y(30),"#111")
# LCD
tagR(RM,y(3),"LCD GND","#111"); tagR(RP,y(5),"LCD VCC","#dc2626")
# divider rows 2-6
tagR(X['j'],y(2),"Uno D3","#f59e0b")
res(X['g'],y(2),X['g'],y(4),"10k"); res(X['h'],y(4),X['h'],y(6),"10k"); res(X['i'],y(6),RM,y(8),"10k")
tagR(X['j'],y(4),"to ESP32 board RX2","#16a34a")
# LDR
wire([(LP,y(6)),(X['a'],y(6))],"#dc2626"); ring(LP,y(6),"#dc2626"); ring(X['a'],y(6),"#dc2626")
res(X["b"],y(8),LM,y(7),"10k"); tagL(X['a'],y(8),"Uno A2","#ca8a04")
for r in (6,8): A(f'<circle cx="{X["d"]}" cy="{y(r)}" r="9" fill="none" stroke="#7c3aed" stroke-width="3" stroke-dasharray="4 3"/>')
T(X['c'],y(7)+4,"LDR","#7c3aed","middle",11)
# cap + servo
ring(RP,y(18),"#dc2626"); ring(RM,y(18),"#111")
A(f'<rect x="{RM+22}" y="{y(18)-14}" width="44" height="28" rx="8" fill="#1e3a8a"/>'); T(RM+44,y(18)+4,"1000µF","#fff","middle",9)
A(f'<line x1="{RP}" y1="{y(18)}" x2="{RM+22}" y2="{y(18)-8}" stroke="#dc2626" stroke-width="3"/>'); A(f'<line x1="{RM}" y1="{y(18)}" x2="{RM+22}" y2="{y(18)+8}" stroke="#111" stroke-width="3"/>')
T(RM+72,y(18)+4,"long leg +, stripe −","#111","start",11)
tagR(RP,y(20),"servo red","#dc2626"); tagR(RM,y(21),"servo brown","#78350f")
# left rail extras
tagL(LM,y(20),"TDS −","#111",x2=LM-40)
tagL(LP,y(25),"pH V+","#dc2626",x2=LP-70); tagL(LM,y(26),"pH G","#111",x2=LM-40)
# legend
X0=1010; yy=150
def sec(title,c,lines):
    global yy
    A(f'<rect x="{X0}" y="{yy}" width="8" height="{22+len(lines)*19}" fill="{c}"/>')
    T(X0+18,yy+15,title,"#111","start",15)
    for i,l in enumerate(lines): A(f'<text x="{X0+18}" y="{yy+36+i*19}" font-size="13" fill="#333" xml:space="preserve">{l}</text>')
    yy+=34+len(lines)*19
sec("Power","#dc2626",["Uno 5V → left + row 1,  Uno GND → left − row 2","Row 30: left + ↔ right +,  left − ↔ right −"])
sec("LCD","#0b7d86",["GND → right − row 3,  VCC → right + row 5","SDA → Uno A4,  SCL → Uno A5   (no holes)"])
sec("LDR (cup wall)","#ca8a04",["a6 → left + row 6,  10k: b8 → left − rail (any hole)","a8 → Uno A2,  LDR leads → d6 + d8 (soldered)"])
sec("TDS + pH (no holes except rails)","#0f766e",["TDS: + → D7,  A → A1,  − → left − row 20","pH: V+ → left + row 25,  G → left − row 26,  Po → A0"])
sec("Servo + cap","#1e3a8a",["cap: long → right + row 18,  stripe → right − row 18","servo: red → right + 20,  brown → right − 21,  orange → D10"])
sec("Radio divider (three 10k) to ESP32 board","#16a34a",["Uno D3 → j2,  10k g2–g4,  10k h4–h6,  10k i6 → right − 8","j4 → ESP32 RX2 (3.3 V tap),  ESP32 TX2 → Uno D9","ESP32 GND → this board blue (−) rail"])
A('</svg></body></html>')
open(sys.argv[2],'w').write('\n'.join(o))
