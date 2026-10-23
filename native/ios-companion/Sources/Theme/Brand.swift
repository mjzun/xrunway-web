//
//  Brand.swift
//  (X)RUNWAY iOS Companion
//
//  The dark-screen brand palette (near-black + Carolina blue — the exact
//  UNC hex; pink is banned by the web palette test). Extracted verbatim
//  from ContentView.swift (A3, mechanical-only) so Solo screens compose
//  from the tokens without importing the capture screen. The light Enter
//  page's tokens live in EnterScreenTokens.swift.
//

import SwiftUI

enum Brand {
    static let bg = Color(red: 0x0a / 255, green: 0x0c / 255, blue: 0x10 / 255)
    static let bgDeep = Color(red: 0x05 / 255, green: 0x07 / 255, blue: 0x0a / 255)
    static let accent = Color(red: 0x4b / 255, green: 0x9c / 255, blue: 0xd3 / 255)        // Carolina blue
    static let accentDeep = Color(red: 0x2f / 255, green: 0x7c / 255, blue: 0xb3 / 255)
    static let accentSoft = Color(red: 0x8e / 255, green: 0xc4 / 255, blue: 0xe8 / 255)
    static let white = Color(red: 0xf2 / 255, green: 0xf5 / 255, blue: 0xf8 / 255)
    static let silver = Color(red: 0x8a / 255, green: 0x8f / 255, blue: 0x96 / 255)
    static let ok = Color(red: 0x5f / 255, green: 0xcf / 255, blue: 0x80 / 255)
    static let warn = Color(red: 0xe7 / 255, green: 0xb8 / 255, blue: 0x5c / 255)
    static let bad = Color(red: 0xe0 / 255, green: 0x6d / 255, blue: 0x6d / 255)
}
