//
//  ModesTests.swift — the `modes` family (4 cases: id/idealPace/passThreshold/
//  weights/walkSeconds per mode). Table equality against MODES.
//

import XCTest
import XRunwayCore

final class ModesTests: XCTestCase {
    func testModes() {
        guard let fam = loadFamilyOrFail("modes") else { return }
        XCTAssertEqual(fam.cases.count, 4, "modes case count")
        for c in fam.cases {
            guard let id = c.input["id"]?.asString else {
                XCTFail("modes case '\(c.name)' missing id")
                continue
            }
            let m = getMode(id)
            var w: [String: JSONValue] = [:]
            for (k, v) in m.weights { w[k] = .number(v) }
            let actual = Enc.obj([
                "id": Enc.str(m.id),
                "idealPace": Enc.num(m.idealPace),
                "passThreshold": Enc.num(m.passThreshold),
                "weights": Enc.obj(w),
                "walkSeconds": Enc.num(m.walkSeconds),
            ])
            assertGolden(actual, c, module: "modes")
        }
    }
}
