import sys
W,H=1900,1300
o=[]
def a(s): o.append(s)
C={'5v':'#d6312b','gnd':'#222','sig':'#1f6fb2','i2c':'#7b3fb0','d7':'#e07b00','lora':'#0f8a6a','usb':'#6b7780'}
def line(pts,col,w=3,dash=None):
    d=' '.join(f'{x},{y}' for x,y in pts)
    a(f'<polyline points="{d}" fill="none" stroke="{col}" stroke-width="{w}" stroke-linejoin="round" stroke-linecap="round"{" stroke-dasharray=%s"%chr(34)+dash+chr(34) if dash else ""}/>')
def dot(x,y,col='#222'): a(f'<circle cx="{x}" cy="{y}" r="5.5" fill="{col}"/>')
def text(x,y,s,size=17,anchor='start',col='#14232e',weight=400,family='Inter,Arial,sans-serif'):
    a(f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" fill="{col}" text-anchor="{anchor}" font-weight="{weight}">{s}</text>')
def box(x,y,w,h,title,sub=None,fill='#f4f7f9',stroke='#2b3a44'):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>')
    text(x+w/2,y+28,title,19,'middle',weight=700)
    if sub: text(x+w/2,y+50,sub,14,'middle',col='#4c5d69')
def pin(x,y,label,side):
    a(f'<rect x="{x-6}" y="{y-6}" width="12" height="12" fill="#fff" stroke="#2b3a44" stroke-width="2"/>')
    if side=='L': text(x+14,y+6,label,15,'start',weight=600)
    elif side=='R': text(x-14,y+6,label,15,'end',weight=600)
    elif side=='B': text(x,y-14,label,14,'middle',weight=600)
def gnd(x,y):
    line([(x,y),(x,y+16)],C['gnd'])
    for i,wd in enumerate((22,14,6)): line([(x-wd/2,y+16+i*6),(x+wd/2,y+16+i*6)],C['gnd'],2.5)
def vcc(x,y,label='+5V'):
    line([(x,y),(x,y-16)],C['5v']); line([(x-12,y-16),(x+12,y-16)],C['5v'],3); text(x,y-24,label,14,'middle',C['5v'],700)
def res(x0,y0,x1,y1,label,col):
    # resistor body centred on the segment
    import math
    mx,my=(x0+x1)/2,(y0+y1)/2; horiz=abs(x1-x0)>abs(y1-y0)
    if horiz:
        line([(x0,y0),(mx-28,my)],col); line([(mx+28,my),(x1,y1)],col)
        a(f'<rect x="{mx-28}" y="{my-10}" width="56" height="20" rx="3" fill="#fff8e6" stroke="#8a6d1f" stroke-width="2.5"/>'); text(mx,my-16,label,14,'middle',col='#6b5414',weight=700)
    else:
        line([(x0,y0),(mx,my-28)],col); line([(mx,my+28),(x1,y1)],col)
        a(f'<rect x="{mx-10}" y="{my-28}" width="20" height="56" rx="3" fill="#fff8e6" stroke="#8a6d1f" stroke-width="2.5"/>'); text(mx+18,my+5,label,14,'start',col='#6b5414',weight=700)

a(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
a(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
text(40,52,'Clarity: as-built wiring (sensors, tipping cup, ESP-NOW radio)',30,weight=800)
text(40,82,'Every +5V symbol goes to the breadboard red (+) rail, every ground symbol to the blue (−) rail. Crossing wires without a dot are NOT connected.',16,col='#4c5d69')

# ---------- Arduino Uno ----------
UX,UY,UW,UH=660,250,300,540
box(UX,UY,UW,UH,'Arduino Uno R3','(the brain)',fill='#e3f0fa',stroke='#1c6fa8')
L={'A0':450,'A1':520,'A2':590}
for k,y in L.items(): pin(UX,y,k,'L')
R={'SDA':300,'SCL':345,'D3':430,'D9':480,'D10':695,'D7':735}
for k,y in R.items(): pin(UX+UW,y,k,'R')
P={'5V':720,'GND':800,'USB':880}
for k,x in P.items(): pin(x,UY+UH,k if k!='USB' else 'USB-B','B')
vcc(720,UY+UH+6); line([(720,UY+UH+6),(720,UY+UH)],C['5v'])
# 5V pin -> rail flag drawn upward is odd; draw flag below instead
o.pop(); o.pop(); o.pop(); o.pop()
line([(720,UY+UH),(720,UY+UH+40)],C['5v']); line([(708,UY+UH+40),(732,UY+UH+40)],C['5v']); text(720,UY+UH+60,'+5V rail',14,'middle',C['5v'],700)
line([(800,UY+UH),(800,UY+UH+24)],C['gnd']); gnd(800,UY+UH+24)

# ---------- pH board ----------
box(110,140,280,210,'pH board PH-4502C','plug in the pH probe (BNC)')
pin(390,215,'V+','R'); pin(390,260,'G','R'); pin(390,310,'Po','R')
line([(390,215),(470,215)],C['5v']); text(478,220,'+5V',14,'start',C['5v'],700)
line([(390,260),(430,260),(430,270)],C['gnd']); gnd(430,270)
line([(390,310),(520,310),(520,450),(UX,450)],C['sig']); dot(UX,450,C['sig'])

# ---------- TDS board ----------
box(110,400,280,190,'TDS board (Inland)','plug in the TDS probe')
pin(390,465,'+','R'); pin(390,510,'−','R'); pin(390,555,'A','R')
line([(390,510),(440,510),(440,515)],C['gnd']); gnd(440,515)
line([(390,555),(560,555),(560,520),(UX,520)],C['sig'])
# D7 powers the TDS board (switched off while pH reads)
line([(UX+UW,735),(1010,735),(1010,870),(480,870),(480,465),(390,465)],C['d7'])

# ---------- LDR divider ----------
box(110,640,280,200,'Light sensor','LDR on the cup wall + 10 kΩ')
a('<g>')
text(126,725,'+5V',14,'start',C['5v'],700)
line([(165,720),(230,720)],C['5v'])
a('<rect x="230" y="708" width="60" height="24" rx="12" fill="#fff" stroke="#9a3b8f" stroke-width="2.5"/>'); text(260,750,'LDR',13,'middle',col='#9a3b8f',weight=700)
line([(290,720),(330,720)],C['sig']); dot(330,720,C['sig'])
res(330,720,330,800,'10 kΩ',C['gnd'])
gnd(330,800)
a('</g>')
line([(330,720),(600,720),(600,590),(UX,590)],C['sig'])

# ---------- LCD ----------
box(1120,120,360,150,'LCD 1602 with I2C backpack','shows readings and the filter choice')
for k,y in (('SDA',175),('SCL',215)): pin(1120,y,k,'L')
pin(1480,175,'VCC','R'); pin(1480,225,'GND','R')
line([(UX+UW,300),(1050,300),(1050,175),(1120,175)],C['i2c'])
line([(UX+UW,345),(1075,345),(1075,215),(1120,215)],C['i2c'])
line([(1480,175),(1530,175)],C['5v']); text(1538,180,'+5V',14,'start',C['5v'],700)
line([(1480,225),(1520,225),(1520,235)],C['gnd']); gnd(1520,235)
text(1300,290,'Wired to A4 (SDA) and A5 (SCL), the same pins',13,'middle',col='#4c5d69')

# ---------- LoRa node ----------
box(1250,330,300,190,'Radio node (board 2)','ESP32-WROOM-32E dev board',fill='#e4f5ef',stroke='#0f8a6a')
pin(1250,400,'RX2 (GPIO16)','L'); pin(1250,475,'TX2 (GPIO17)','L'); pin(1320,520,'GND','B'); text(1475,440,'RX2 gets 3.3 V from',13,'middle',col='#4c5d69'); text(1475,458,'the 10 kΩ divider',13,'middle',col='#4c5d69')
line([(1460,330),(1460,300)],C['lora'],3); a('<path d="M1446,300 L1474,300 L1460,282 Z" fill="#0f8a6a"/>')
res(UX+UW,430,1130,430,'10 kΩ',C['lora']); line([(1130,430),(1180,430)],C['lora']); dot(1180,430,C['lora'])
line([(1180,430),(1180,400),(1250,400)],C['lora'])
res(1180,430,1180,520,'',C['lora']); text(1168,466,'2× 10 kΩ',14,'end',col='#6b5414',weight=700); gnd(1180,520); line([(1250,475),(1222,475),(1222,610),(1100,610),(1100,480),(UX+UW,480)],C['lora'])
line([(1320,520),(1320,540)],C['gnd']); gnd(1320,540)


# ---------- Power bank ----------
box(640,960,340,110,'USB power bank','powers the Uno, sensors and servo',fill='#f2f2f2',stroke='#6b7780')
line([(880,1+UY+UH),(880,960)],C['usb'],5); text(890,900,'USB-B cable',14,'start',C['usb'],700)
pin(1440,520,'micro-USB','B'); line([(1440,520),(1440,550)],C['usb'],5); text(1440,570,'own power bank port',13,'middle',C['usb'],700)


# ---------- Filter servo + capacitor ----------
C['servo']='#e07b00'
line([(UX+UW,695),(1035,695),(1035,880),(1100,880)],C['servo'])
box(1100,790,260,150,'SG90CR 360° servo','tips the test cup left or right',fill='#fff4e5',stroke='#b26a00')
pin(1100,880,'orange','L'); pin(1360,850,'red','R'); pin(1360,900,'brown','R')
line([(1360,850),(1470,850)],C['5v']); text(1478,855,'+5V',14,'start',C['5v'],700)
line([(1360,900),(1440,900),(1440,910)],C['gnd']); gnd(1440,910)
# capacitor between 5V and GND near servo
line([(1470,850),(1470,862)],C['5v']); line([(1455,862),(1485,862)],'#222',3); a('<path d="M1455,872 Q1470,866 1485,872" fill="none" stroke="#222" stroke-width="3"/>'); line([(1470,870),(1470,900),(1440,900)],C['gnd'])
text(1495,885,'1000 µF capacitor',13,'start',col='#6b5414',weight=700); text(1495,903,'(stripe/− side to GND)',12,'start',col='#4c5d69')

C['water']='#2b8fd6'
# water path inset
a('<rect x="1060" y="1110" width="820" height="170" rx="10" fill="#f3f9fd" stroke="#9cc8e6" stroke-width="2"/>')
text(1080,1140,'What the cup does',17,weight=800,col='#1d5f8f')
steps=(('Test cup','TDS, pH, clarity'),('Decide','rule or base station'),('Tip left','PUR Plus: TDS > 300'),('Tip right','Brita: clarity < 70%'),('Clean','cup stays upright'))
for i,(t1,t2) in enumerate(steps):
    x=1075+i*160
    a(f'<rect x="{x}" y="1160" width="138" height="90" rx="10" fill="#fff" stroke="#2b8fd6" stroke-width="2"/>')
    text(x+69,1195,t1,14,'middle',weight=700); text(x+69,1220,t2,12,'middle',col='#4c5d69')
    if i<4: line([(x+140,1205),(x+156,1205)],C['water'],4); a(f'<path d="M{x+152},1198 L{x+160},1205 L{x+152},1212 Z" fill="#2b8fd6"/>')

# ---------- Gateway + laptop ----------
box(1610,330,260,190,'Radio receiver','ESP32 at the base station',fill='#e4f5ef',stroke='#0f8a6a')
text(1740,420,'receives each result and',13,'middle',col='#4c5d69'); text(1740,438,'passes it to the Pi over USB',13,'middle',col='#4c5d69')
line([(1700,330),(1700,300)],C['lora'],3); a('<path d="M1686,300 L1714,300 L1700,282 Z" fill="#0f8a6a"/>')
line([(1480,291),(1680,291)],C['lora'],3,'10 8'); text(1580,320,'ESP-NOW link, no Wi‑Fi or cell',13,'middle',C['lora'],700)
box(1610,640,260,130,'Raspberry Pi base station','gateway, dashboard, remote start',fill='#f2f2f2',stroke='#6b7780')
line([(1740,520),(1740,640)],C['usb'],5); text(1750,590,'micro-USB',14,'start',C['usb'],700)

# ---------- Pin table ----------
tx,ty=40,880
a(f'<rect x="{tx}" y="{ty}" width="560" height="345" rx="10" fill="#fafbfc" stroke="#cdd8df" stroke-width="2"/>')
text(tx+18,ty+32,'Uno pin map (for the code)',18,weight=800)
rows=[('A0','pH board Po'),('A1','TDS board A'),('D7','TDS board + (switched power)'),('A2','LDR / 10 kΩ junction (room light)'),('A4 / A5','LCD SDA / SCL (I2C, 0x27)'),('D10','SG90 360° servo signal (orange)'),('D3','→ 10 kΩ → ESP32 RX2; 2× 10 kΩ to GND'),('D9','← ESP32 TX2 (commands, remote start)'),('5V / GND','rails; 1000 µF across the servo supply')]
for i,(p_,d_) in enumerate(rows):
    text(tx+18,ty+64+i*25,p_,15,weight=700,family='IBM Plex Mono,monospace'); text(tx+170,ty+64+i*25,d_,15)

a('</svg>')
open(sys.argv[2],'w').write('\n'.join(o))
