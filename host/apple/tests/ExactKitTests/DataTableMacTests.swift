#if os(macOS)
import AppKit
import XCTest
@testable import ExactKit

final class DataTableMacTests: XCTestCase {
    func testPressingAHeaderExposesTheNewSortDirectionAndRowOrder() throws {
        _ = NSApplication.shared
        let session = ExactApp.shared.makeSession(label: "data-table")
        let size = CGSize(width: 500, height: 300)
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { session.destroy(); window.close() }
        window.contentView = ExactView(session: session)
        window.layoutIfNeeded()
        let plan = try TableFixture.plan("""
        component App
          state step = 0
          derive direction = step == 0 ? "ascending" : (step == 1 ? "descending" : (step == 2 ? "other" : "none"))
          derive names = step == 0 ? ["Ada", "Lin"] : ["Lin", "Ada"]
          action sort
            step = (step + 1) % 4
          view
            table testId="people"
              thead
                tr
                  th testId="name" press=sort aria-sort=direction
                    text "Name"
                  th testId="team"
                    text "Team"
              tbody
                for name in names key=name
                  tr
                    td testId=name
                      text name
                    td
                      text "Engineering"

        """)
        XCTAssertNil(session.boot(plan: plan, size: size).error)
        let presenter = session.presenter
        presenter.settlePump()
        let people = try XCTUnwrap(presenter.views.values.first { $0.props["testId"] == "people" })
        let name = try XCTUnwrap(presenter.views.values.first { $0.props["testId"] == "name" })
        func firstName() -> String? { people.tableCell(row: 1, column: 0)?.props["testId"] }
        let team = try XCTUnwrap(presenter.views.values.first { $0.props["testId"] == "team" })
        func direction(_ node: NodeView) -> String? {
            node.accessibilityAttributeValue(.sortDirection) as? String
        }
        XCTAssertEqual(firstName(), "Ada")
        XCTAssertEqual(name.accessibilitySortDirection(), .ascending)
        XCTAssertTrue(name.accessibilityAttributeNames().contains(.sortDirection))
        XCTAssertEqual(direction(name), NSAccessibility.SortDirectionValue.ascending.rawValue)
        XCTAssertFalse(team.accessibilityAttributeNames().contains(.sortDirection))
        XCTAssertNil(direction(team))
        func pressHeader() {
            XCTAssertTrue(name.accessibilityPerformPress())
            let pressed = expectation(description: "AppKit delivered the header press")
            DispatchQueue.main.async { pressed.fulfill() }
            wait(for: [pressed], timeout: 2)
            presenter.settlePump()
        }
        pressHeader()
        XCTAssertEqual(firstName(), "Lin")
        XCTAssertEqual(name.accessibilitySortDirection(), .descending)
        XCTAssertEqual(direction(name), NSAccessibility.SortDirectionValue.descending.rawValue)
        pressHeader()
        XCTAssertEqual(direction(name), NSAccessibility.SortDirectionValue.unknown.rawValue)
        pressHeader()
        XCTAssertFalse(name.accessibilityAttributeNames().contains(.sortDirection))
        XCTAssertNil(direction(name))
    }
}
#endif
