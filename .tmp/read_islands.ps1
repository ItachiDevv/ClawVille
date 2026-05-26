$j = Get-Content 'C:\Users\newma\Documents\Crypto\ClawVille\.tmp\casino_islands.json' -Raw | ConvertFrom-Json
$islands = $j.islands
Write-Output "Total islands: $($islands.Count)"
Write-Output "Scale: $($j.autofit.scale)"
Write-Output "Max dim: $($j.autofit.max_dim)"
Write-Output "Dims: $($j.autofit.dims)"
Write-Output "GLB X: $($j.autofit.glb_bounds.x)"
Write-Output "GLB Y: $($j.autofit.glb_bounds.y)"
Write-Output "GLB Z: $($j.autofit.glb_bounds.z)"
Write-Output ""
Write-Output "Islands sorted by world Z desc (top 30):"
$islands | Select-Object -First 30 | ForEach-Object {
    $wc = $_.world_centroid
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    Write-Output "  [$($_.island_idx)] mesh=$($_.mesh) faces=$($_.face_count) verts=$($_.vert_count)"
    Write-Output "    GLB centroid: $([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1))"
    Write-Output "    World centroid: $([math]::Round($wc[0],1)), $([math]::Round($wc[1],1)), $([math]::Round($wc[2],1))"
    Write-Output "    Local size XYZ: $([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1))"
}
Write-Output ""
Write-Output "Islands sorted by world Z desc (last 20 = lowest Z):"
$islands | Select-Object -Last 20 | ForEach-Object {
    $wc = $_.world_centroid
    $gc = $_.glb_centroid
    $sz = $_.local_size_xyz
    Write-Output "  [$($_.island_idx)] mesh=$($_.mesh) faces=$($_.face_count) verts=$($_.vert_count)"
    Write-Output "    GLB centroid: $([math]::Round($gc[0],1)), $([math]::Round($gc[1],1)), $([math]::Round($gc[2],1))"
    Write-Output "    World centroid: $([math]::Round($wc[0],1)), $([math]::Round($wc[1],1)), $([math]::Round($wc[2],1))"
    Write-Output "    Local size XYZ: $([math]::Round($sz[0],1)), $([math]::Round($sz[1],1)), $([math]::Round($sz[2],1))"
}
