Add-Type -AssemblyName System.Drawing
function RoundRect {
  param([double]$x,[double]$y,[double]$w,[double]$h,[double]$r)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [float]($r * 2)
  $x = [float]$x; $y = [float]$y; $w = [float]$w; $h = [float]$h
  $p.AddArc($x, $y, $d, $d, [float]180, [float]90)
  $p.AddArc($x + $w - $d, $y, $d, $d, [float]270, [float]90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, [float]0, [float]90)
  $p.AddArc($x, $y + $h - $d, $d, $d, [float]90, [float]90)
  $p.CloseFigure()
  return $p
}
foreach ($s in @(16,32,48,128)) {
  $W = $s * 8
  $bmp = New-Object System.Drawing.Bitmap $W, $W
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $blue = [System.Drawing.Color]::FromArgb(255, 78, 110, 242)
  $blueDark = [System.Drawing.Color]::FromArgb(255, 62, 92, 216)
  $white = [System.Drawing.Color]::White
  $gray = [System.Drawing.Color]::FromArgb(255, 203, 213, 225)
  $bg = RoundRect 0 0 $W $W ($W * 0.22)
  $g.FillPath((New-Object System.Drawing.SolidBrush $blue), $bg)
  $paperBr = New-Object System.Drawing.SolidBrush $white
  $g.FillPath($paperBr, (RoundRect ($W*0.27) ($W*0.13) ($W*0.46) ($W*0.40) ($W*0.05)))
  $g.FillPath($paperBr, (RoundRect ($W*0.15) ($W*0.40) ($W*0.70) ($W*0.33) ($W*0.08)))
  $slotBr = New-Object System.Drawing.SolidBrush $blueDark
  $g.FillPath($slotBr, (RoundRect ($W*0.30) ($W*0.475) ($W*0.40) ($W*0.045) ($W*0.02)))
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $blue), [float]($W*0.735), [float]($W*0.47), [float]($W*0.05), [float]($W*0.05))
  $g.FillPath($paperBr, (RoundRect ($W*0.28) ($W*0.66) ($W*0.44) ($W*0.24) ($W*0.04)))
  $lineBr = New-Object System.Drawing.SolidBrush $gray
  $g.FillRectangle($lineBr, [float]($W*0.33), [float]($W*0.715), [float]($W*0.30), [float]($W*0.035))
  $g.FillRectangle($lineBr, [float]($W*0.33), [float]($W*0.775), [float]($W*0.22), [float]($W*0.035))
  $g.Dispose()
  $bmp.Save("C:\Users\Chinasoft\Documents\GitHub\doubao_print\icons\icon$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "icon$s ok"
}
