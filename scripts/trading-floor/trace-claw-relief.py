"""Trace the shipped brand claw alpha into a simple filled relief outline."""
import json
import sys
import cv2
from shapely.geometry import Polygon
from shapely.ops import triangulate

image = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
alpha = image[:, :, 3]
_, mask = cv2.threshold(alpha, 100, 255, cv2.THRESH_BINARY)
contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
outline = max(contours, key=cv2.contourArea)
outline = cv2.approxPolyDP(outline, 1.6, True)[:, 0, :]
poly = Polygon([tuple(map(int, point)) for point in outline])
if not poly.is_valid:
    poly = poly.buffer(0)
tris = [tri for tri in triangulate(poly) if poly.covers(tri)]
print(json.dumps({
    'outline': [list(map(int, point)) for point in outline],
    'triangles': [list(map(list, list(tri.exterior.coords)[:3])) for tri in tris],
}))
