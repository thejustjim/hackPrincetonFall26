import cadquery as cq, math
RING_OD, RING_T = 84.0-0.8, 3.0          # same as Salih's rings: sits on the blue cup's 84 mm ledge
def cyl(r,h,z=0): return cq.Workplane("XY").workplane(offset=z).circle(r).extrude(h)
for d,lab in ((55.0,"PUR 55.0"),(55.6,"PUR 55.6")):
    r = cyl(RING_OD/2, RING_T).cut(cyl(d/2, RING_T+1, -0.5))
    rr = (RING_OD/2 + d/2)/2
    r = r.union(cq.Workplane("XY").workplane(offset=RING_T).center(0,-rr).text(lab.split()[1],5,0.6,kind="bold",halign="center",valign="center"))
    r = r.union(cq.Workplane("XY").workplane(offset=RING_T).center(0, rr).text("PUR",5,0.6,kind="bold",halign="center",valign="center"))
    n=f"ring_PUR_{str(d).replace('.','p')}mm"
    cq.exporters.export(r, n+".stl", tolerance=0.02, angularTolerance=0.1)
    cq.exporters.export(r, n+".step")
    print(n, "hole circumference in:", round(math.pi*d/25.4,3))
print("filter body from 6.75 in:", round(6.75*25.4/math.pi,2),"mm")
