# composite-logo.ps1 — paste an exact logo PNG onto a generated turnaround view.
# Deterministic branding: diffusion models cannot reproduce a trademark exactly,
# so the real logo file is composited over the cap-front area post-generation
# (biggie pipeline, 2026-07-22). The logo's black circle background blends into
# the black cap, covering whatever approximate mark the model drew.
#
# Usage: powershell -File composite-logo.ps1 -Image <view.png> -Logo <logo.png> -X <px> -Y <px> -W <px> [-SquashX <0..1>]
#   X/Y = top-left of the pasted logo in image pixels; W = pasted width
#   SquashX compresses horizontally for angled (3/4) views.
param(
  [Parameter(Mandatory=$true)][string]$Image,
  [Parameter(Mandatory=$true)][string]$Logo,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [double]$SquashX = 1.0
)
Add-Type -AssemblyName System.Drawing
$imgObj  = [System.Drawing.Image]::FromFile((Resolve-Path $Image))
$logoObj = [System.Drawing.Image]::FromFile((Resolve-Path $Logo))
# logo aspect: keep native ratio, then apply horizontal squash
$h = [int]($W * $logoObj.Height / $logoObj.Width)
$wS = [int]($W * $SquashX)
$g = [System.Drawing.Graphics]::FromImage($imgObj)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($logoObj, $X, $Y, $wS, $h)
$g.Dispose()
$out = (Resolve-Path $Image).Path
$logoObj.Dispose()
$tmp = "$out.tmp.png"
$imgObj.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$imgObj.Dispose()
Move-Item -Force $tmp $out
Write-Host "composited $Logo -> $out at ($X,$Y) w=$wS h=$h"
