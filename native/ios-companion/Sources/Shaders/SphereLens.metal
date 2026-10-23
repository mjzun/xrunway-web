//
//  SphereLens.metal
//  (X)RUNWAY iOS Companion — Phase 3 (optional, removable)
//
//  A [[stitchable]] SwiftUI layer effect that makes the floating glass sphere act
//  like a real crystal-ball lens over the content behind it (ref_3): it
//  magnifies the area inside the sphere (spherical bulge) and splits the R/G/B
//  channels radially for chromatic aberration, with a faint bright rim so the
//  glass edge reads as thickness.
//
//  Applied to the BACKGROUND content layer (the off-white page + headline) so the
//  sphere refracts what is behind it. `center`/`radius` are in SwiftUI user-space
//  POINTS (the same space layer.sample() uses); `refraction`/`aberration` are
//  ramped from 0 by the host as the lift progresses, so at rest the effect is a
//  pure passthrough.
//

#include <metal_stdlib>
#include <SwiftUI/SwiftUI.h>
using namespace metal;

[[ stitchable ]]
half4 sphereLens(float2 position,
                 SwiftUI::Layer layer,
                 float2 center,      // sphere center, user-space points
                 float  radius,      // sphere radius, points
                 float  refraction,  // ~0–0.45, magnification strength
                 float  aberration)  // ~0–10, RGB split in points at the rim
{
    // Rest / no-lift: identity passthrough (avoids any rim artifact at progress 0).
    if (refraction <= 0.0001 && aberration <= 0.0001) {
        return layer.sample(position);
    }

    float2 toCenter = position - center;
    float  dist     = length(toCenter);

    // Outside the sphere: pass through untouched.
    if (dist >= radius) { return layer.sample(position); }

    float  r   = dist / radius;                 // 0 at center → 1 at rim
    float2 dir = (dist > 0.0) ? toCenter / dist : float2(0.0);

    // Spherical surface profile: pull samples inward, strongest toward the rim,
    // which magnifies the center.
    float  bulge     = 1.0 - sqrt(max(0.0, 1.0 - r * r));
    float2 displaced = position - dir * bulge * radius * refraction;

    // Chromatic aberration: spread the channels radially, growing toward the rim.
    float2 ca = dir * aberration * r;
    half4 cr = layer.sample(displaced + ca);
    half4 cg = layer.sample(displaced);
    half4 cb = layer.sample(displaced - ca);
    half4 color = half4(cr.r, cg.g, cb.b, cg.a);

    // Subtle bright rim so the glass edge reads as thickness.
    float edge = smoothstep(0.86, 1.0, r);
    color.rgb += half3(0.07) * edge;
    return color;
}
