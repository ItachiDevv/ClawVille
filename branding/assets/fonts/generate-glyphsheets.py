import base64, io, sys, urllib.request, json

key = None
with io.open(r"C:\Users\itachi\documents\crypto\clawville\.env.local", encoding="utf8") as f:
    for line in f:
        if line.strip().startswith("OPENAI_API_KEY="):
            key = line.strip().split("=", 1)[1].strip().strip('"').strip("'"); break

STYLE = (
    "Reproduce EXACTLY the lettering style of the word Clawville shown in the reference images: plump, rounded, "
    "hand-drawn slab-serif letters with a soft dimensional 3D feel, gentle rounding and subtle highlights on the "
    "letter faces exactly like the reference, golden yellow letters with slightly deeper golden shading toward the "
    "bottom edges, and a thick chocolate-brown offset drop shadow to the lower-right, just like the reference. "
    "Each letter slightly tilted with a playful bouncy baseline, chunky rounded serifs, charming hand-drawn "
    "irregularity, matching the reference letterforms as closely as possible. Letters LARGE and clearly SEPARATED "
    "with generous gaps between them, never touching or overlapping. Plain solid white background, no sign, no "
    "wood plank, no decorations, no extra marks, crisp high resolution."
)
SHEETS = {
    "upper": "Two rows of large uppercase letters. Row one: A B C D E F G H I J K L M. Row two: N O P Q R S T U V W X Y Z. " + STYLE,
    "lower": "Two rows of large lowercase letters. Row one: a b c d e f g h i j k l m. Row two: n o p q r s t u v w x y z. Include every letter, ending with lowercase z. " + STYLE,
    "digits": "One row of large digits: 0 1 2 3 4 5 6 7 8 9. All ten digits once each, in order. " + STYLE,
}
REFS = [
    r"C:\Users\itachi\documents\crypto\clawville\branding\assets\logos\clawville-logo-transparent.png",
    r"C:\Users\itachi\documents\crypto\clawville\branding\assets\logos\clawville-logo-wood-large.png",
    r"C:\Users\itachi\documents\crypto\clawville\branding\assets\logos\clawville-logo-official.jpg",
]

name, out = sys.argv[1], sys.argv[2]
boundary = "----glyphv3"
parts = []
def field(n, v):
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, n, v)).encode())
field("model", "gpt-image-2")
field("prompt", SHEETS[name])
field("size", "1536x1024")
field("quality", "high")
field("n", "1")
for ri, rp in enumerate(REFS):
    with open(rp, "rb") as fh:
        data = fh.read()
    ctype = "image/jpeg" if rp.endswith(".jpg") else "image/png"
    head = "--%s\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"ref%d\"\r\nContent-Type: %s\r\n\r\n" % (boundary, ri, ctype)
    parts.append(head.encode() + data + b"\r\n")
parts.append(("--%s--\r\n" % boundary).encode())

req = urllib.request.Request("https://api.openai.com/v1/images/edits", data=b"".join(parts),
    headers={"Authorization": "Bearer " + key, "Content-Type": "multipart/form-data; boundary=" + boundary})
try:
    with urllib.request.urlopen(req, timeout=420) as r:
        res = json.load(r)
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:300]); sys.exit(1)
with open(out, "wb") as f:
    f.write(base64.b64decode(res["data"][0]["b64_json"]))
print("saved", out)
