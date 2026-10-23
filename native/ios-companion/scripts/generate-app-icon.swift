#!/usr/bin/env swift
//
//  generate-app-icon.swift — (X)RUNWAY iOS Companion
//
//  Regenerates the app icon (1024x1024 opaque PNG, the single size iOS 26
//  needs in an asset catalog) from code — CoreGraphics/CoreText only, no
//  external tools. Matches the founder's faceted-green "(X)RUNWAY" logo:
//
//    - background  #0a0c10  (Brand.bg — keeps the app-family dark field)
//    - mark        "(X)" in Impact, sheared ~11 deg like BrandWordmark.swift
//    - mark fill   low-poly green facets sampled from the logo (light mint
//                  through deep leaf green), lit top-left to bottom-right
//    - a very faint green radial glow so the field doesn't read dead flat
//
//  The facet lattice is seeded (LCG) so regeneration is byte-stable.
//
//  Usage (from native/ios-companion/):
//    swift scripts/generate-app-icon.swift \
//        Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
//

import Foundation
import CoreGraphics
import CoreText
import ImageIO

let canvas = 1024
let slant: CGFloat = 0.2   // EnterTokens.headlineSlant — tan(~11 deg)

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: srgb, components: [
        CGFloat((hex >> 16) & 0xff) / 255.0,
        CGFloat((hex >> 8) & 0xff) / 255.0,
        CGFloat(hex & 0xff) / 255.0,
        alpha,
    ])!
}

let bg = rgb(0x0a0c10)
// Facet palette eyeballed from the logo: mint highlights -> deep leaf green.
let greenBaseTop = rgb(0x8ccf8f)
let greenBaseBottom = rgb(0x3f8f4c)
let facetGreens: [UInt32] = [0xa8dca8, 0x8ccf8f, 0x6dbe71, 0x5baf63, 0x3f8f4c, 0x2f7a3f]
let glowGreen: UInt32 = 0x5baf63

guard let ctx = CGContext(data: nil, width: canvas, height: canvas,
                          bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("could not create CGContext")
}

// 1. Near-black field (opaque — App Store icons must not carry alpha).
ctx.setFillColor(bg)
ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))

// 2. Faint green glow centered behind the mark.
let glowColors = [rgb(glowGreen, 0.13), rgb(glowGreen, 0.0)] as CFArray
let glow = CGGradient(colorsSpace: srgb, colors: glowColors, locations: [0, 1])!
let mid = CGPoint(x: 512, y: 512)
ctx.drawRadialGradient(glow, startCenter: mid, startRadius: 0,
                       endCenter: mid, endRadius: 620, options: [])

// 3. The "(X)" mark. Impact ships with macOS; refuse a silent font fallback
//    so the committed icon can never quietly drift off-brand.
let fontName = "Impact" as CFString
let probeFont = CTFontCreateWithName(fontName, 100, nil)
let psName = CTFontCopyPostScriptName(probeFont) as String
guard psName.localizedCaseInsensitiveContains("impact") else {
    fatalError("Impact not available (resolved \(psName)) — icon would not match the wordmark")
}

func markLine(_ font: CTFont) -> CTLine {
    let attrs: [CFString: Any] = [
        kCTFontAttributeName: font,
        // Color is irrelevant — the line is used as a CLIP; fills follow.
        kCTForegroundColorAttributeName: rgb(0xffffff),
    ]
    let str = CFAttributedStringCreate(nil, "(X)" as CFString, attrs as CFDictionary)!
    return CTLineCreateWithAttributedString(str)
}

// Fit the SHEARED mark to ~620 px (a 1024 canvas with generous margins, so the
// mark survives iOS's icon corner mask and small home-screen sizes).
ctx.textPosition = .zero
let probeBounds = CTLineGetImageBounds(markLine(probeFont), ctx)
let targetWidth: CGFloat = 620
let shearedProbeWidth = probeBounds.width + slant * probeBounds.height
let fontSize = 100 * targetWidth / shearedProbeWidth
let font = CTFontCreateWithName(fontName, fontSize, nil)
let mark = markLine(font)
ctx.textPosition = .zero
let bounds = CTLineGetImageBounds(mark, ctx)

// Seeded LCG so the facet lattice (and therefore the PNG) is reproducible.
var lcgState: UInt64 = 0x5eed_c0de
func rand01() -> CGFloat {
    lcgState = lcgState &* 6364136223846793005 &+ 1442695040888963407
    return CGFloat((lcgState >> 33) & 0xffff_ffff) / CGFloat(UInt32.max)
}

// 4. Draw sheared about the glyph's optical center, centered on the canvas.
//    The glyphs become a CLIP; inside it: base gradient + jittered facet
//    triangles — the logo's low-poly crystal read.
ctx.saveGState()
ctx.translateBy(x: mid.x, y: mid.y)
ctx.concatenate(CGAffineTransform(a: 1, b: 0, c: slant, d: 1, tx: 0, ty: 0))
ctx.translateBy(x: -bounds.midX, y: -bounds.midY)
ctx.textPosition = .zero
ctx.setTextDrawingMode(.clip)
CTLineDraw(mark, ctx)

// 4a. Base vertical gradient (mint top -> leaf bottom, like the logo's light).
let baseColors = [greenBaseTop, greenBaseBottom] as CFArray
let baseGrad = CGGradient(colorsSpace: srgb, colors: baseColors, locations: [0, 1])!
ctx.drawLinearGradient(baseGrad,
                       start: CGPoint(x: bounds.midX, y: bounds.maxY),
                       end: CGPoint(x: bounds.midX, y: bounds.minY),
                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

// 4b. Facets: a jittered triangular lattice across the mark, each triangle
//     one palette green at partial alpha. Over the gradient this reads as
//     the logo's faceted crystal without per-glyph geometry.
let pad: CGFloat = fontSize * 0.1
let region = bounds.insetBy(dx: -pad, dy: -pad)
let cols = 9
let rows = 5
let cw = region.width / CGFloat(cols)
let chRow = region.height / CGFloat(rows)
var grid: [[CGPoint]] = []
for r in 0...rows {
    var rowPts: [CGPoint] = []
    for c in 0...cols {
        let jx = (rand01() - 0.5) * cw * 0.75
        let jy = (rand01() - 0.5) * chRow * 0.75
        rowPts.append(CGPoint(x: region.minX + CGFloat(c) * cw + jx,
                              y: region.minY + CGFloat(r) * chRow + jy))
    }
    grid.append(rowPts)
}
func fillTriangle(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) {
    let shade = facetGreens[Int(rand01() * CGFloat(facetGreens.count)) % facetGreens.count]
    // Mostly translucent tints; occasionally a bright mint catch-light.
    let alpha: CGFloat = rand01() < 0.12 ? 0.5 : 0.12 + rand01() * 0.24
    ctx.setFillColor(rgb(shade, alpha))
    ctx.beginPath()
    ctx.move(to: a); ctx.addLine(to: b); ctx.addLine(to: c)
    ctx.closePath()
    ctx.fillPath()
}
for r in 0..<rows {
    for c in 0..<cols {
        let p00 = grid[r][c], p10 = grid[r][c + 1]
        let p01 = grid[r + 1][c], p11 = grid[r + 1][c + 1]
        // Alternate the diagonal so facet seams don't stripe.
        if (r + c) % 2 == 0 {
            fillTriangle(p00, p10, p11)
            fillTriangle(p00, p11, p01)
        } else {
            fillTriangle(p10, p01, p00)
            fillTriangle(p10, p11, p01)
        }
    }
}
ctx.restoreGState()

// 5. Write the PNG.
let outPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
let image = ctx.makeImage()!
guard let dest = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: outPath) as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("could not open \(outPath) for writing")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("PNG write failed") }
print("wrote \(outPath) (\(canvas)x\(canvas))")
