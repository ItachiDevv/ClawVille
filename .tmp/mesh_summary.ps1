$j = Get-Content 'C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_islands.json' -Raw | ConvertFrom-Json
$islands = $j.islands

Write-Output "=== DISTINCT mesh names ==="
$islands | ForEach-Object { $_.mesh } | Sort-Object -Unique | ForEach-Object { Write-Output "  $_" }

Write-Output ""
Write-Output "=== Island count per mesh ==="
$islands | Group-Object mesh | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object {
    Write-Output "  $($_.Name): $($_.Count) islands"
}

Write-Output ""
Write-Output "=== Face count distribution ==="
$buckets = @{}
foreach ($isl in $islands) {
    $fc = $isl.face_count
    if ($fc -le 2) { $k = "1-2" }
    elseif ($fc -le 5) { $k = "3-5" }
    elseif ($fc -le 10) { $k = "6-10" }
    elseif ($fc -le 20) { $k = "11-20" }
    elseif ($fc -le 50) { $k = "21-50" }
    elseif ($fc -le 100) { $k = "51-100" }
    else { $k = "100+" }
    if ($buckets[$k]) { $buckets[$k]++ } else { $buckets[$k] = 1 }
}
$buckets.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Output "  $($_.Key): $($_.Value)" }

Write-Output ""
# The material3.004 islands at wZ ~273-390 are table-height objects spanning 226 blender units horizontally
# Let's find all Material3.004 islands and their positions
Write-Output "=== All Material3.004 islands (likely poker table surface/felt) ==="
$scale = 1.9671392651514987
$centerX = -720.549732
$minZ_blender = -274.3991394
$centerY_blender = 0.2901287

$m3_004 = $islands | Where-Object { $_.mesh -eq 'Material3.004' }
Write-Output "Count: $($m3_004.Count)"
$m3_004 | Sort-Object { $_.glb_centroid[1] } | ForEach-Object {
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    $wX = ($gc[0] - $centerX) * $scale
    $wY = ($gc[2] - $minZ_blender) * $scale
    $wZ = ($gc[1] - $centerY_blender) * $scale
    Write-Output "  [$($_.island_idx)] f=$($_.face_count) v=$($_.vert_count)"
    Write-Output "    Blender: ($([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1)))"
    Write-Output "    World: ($([math]::Round($wX,1)), $([math]::Round($wY,1)), $([math]::Round($wZ,1))) [wZ=depth, spawn@+800]"
    Write-Output "    Sz: ($([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1)))"
}

Write-Output ""
Write-Output "=== All Material3.006 islands (wall/cabinet structures?) ==="
$m3_006 = $islands | Where-Object { $_.mesh -eq 'Material3.006' }
Write-Output "Count: $($m3_006.Count)"
$m3_006 | Sort-Object { $_.glb_centroid[1] } | Select-Object -First 30 | ForEach-Object {
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    $wX = ($gc[0] - $centerX) * $scale
    $wY = ($gc[2] - $minZ_blender) * $scale
    $wZ = ($gc[1] - $centerY_blender) * $scale
    Write-Output "  [$($_.island_idx)] f=$($_.face_count) v=$($_.vert_count)"
    Write-Output "    Blender: ($([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1)))"
    Write-Output "    World: ($([math]::Round($wX,1)), $([math]::Round($wY,1)), $([math]::Round($wZ,1)))"
    Write-Output "    Sz: ($([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1)))"
}
