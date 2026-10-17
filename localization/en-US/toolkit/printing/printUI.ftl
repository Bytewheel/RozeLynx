
printui-title = Print
printui-save-to-pdf-title = Save As

printui-sheets-count =
    { $sheetCount ->
        [one] { $sheetCount } sheet of paper
       *[other] { $sheetCount } sheets of paper
    }

printui-page-range-all = All
printui-page-range-current = Current
printui-page-range-odd = Odd
printui-page-range-even = Even
printui-page-range-custom = Custom
printui-page-range-label = Pages
printui-page-range-picker =
  .aria-label = Pick page range
printui-page-custom-range-input =
  .aria-label = Enter custom page range
  .placeholder = e.g. 2-6, 9, 12-16

printui-copies-label = Copies

printui-orientation = Orientation
printui-orientation-control =
  .aria-label = Orientation
printui-landscape-2 =
  .label = Landscape
  .title = Landscape
printui-portrait-2 =
  .label = Portrait
  .title = Portrait

printui-destination-label = Destination
printui-destination-pdf-label = Save to PDF

printui-more-settings = More settings
printui-less-settings = Fewer settings

printui-paper-size-label = Paper size

printui-scale = Scale
printui-scale-fit-to-page-width = Fit to page width
printui-scale-pcent = Scale

printui-two-sided-printing = Two-sided printing
printui-two-sided-printing-off = Off
printui-two-sided-printing-long-edge = Flip on long edge
printui-two-sided-printing-short-edge = Flip on short edge

printui-options = Options
printui-headers-footers-checkbox = Print headers and footers
printui-backgrounds-checkbox = Print backgrounds


printui-source-label = Format
printui-source-radio = Original
printui-selection-radio = Selection
printui-simplify-page-radio = Simplified


printui-color-mode-label = Color mode
printui-color-mode-color = Color
printui-color-mode-bw = Black and white

printui-margins = Margins
printui-margins-default = Default
printui-margins-min = Minimum
printui-margins-none = None
printui-margins-custom-inches = Custom (inches)
printui-margins-custom-mm = Custom (mm)
printui-margins-custom-top = Top
printui-margins-custom-top-inches = Top (inches)
printui-margins-custom-top-mm = Top (mm)
printui-margins-custom-bottom = Bottom
printui-margins-custom-bottom-inches = Bottom (inches)
printui-margins-custom-bottom-mm = Bottom (mm)
printui-margins-custom-left = Left
printui-margins-custom-left-inches = Left (inches)
printui-margins-custom-left-mm = Left (mm)
printui-margins-custom-right = Right
printui-margins-custom-right-inches = Right (inches)
printui-margins-custom-right-mm = Right (mm)

printui-system-dialog-link = Print using the system dialog…

printui-primary-button = Print
printui-primary-button-save = Save
printui-cancel-button = Cancel
printui-close-button = Close

printui-loading = Preparing Preview

printui-preview-label =
    .aria-label = Print Preview

printui-pages-per-sheet = Pages per sheet

printui-print-progress-indicator = Printing…
printui-print-progress-indicator-saving = Saving…


printui-paper-a5 = A5
printui-paper-a4 = A4
printui-paper-a3 = A3
printui-paper-a2 = A2
printui-paper-a1 = A1
printui-paper-a0 = A0
printui-paper-b5 = B5
printui-paper-b4 = B4
printui-paper-jis-b5 = JIS-B5
printui-paper-jis-b4 = JIS-B4
printui-paper-letter = US Letter
printui-paper-legal = US Legal
printui-paper-tabloid = Tabloid


printui-error-invalid-scale = Scale must be a number between 10 and 200.
printui-error-invalid-margin = Please enter a valid margin for the selected paper size.
printui-error-invalid-copies = Copies must be a number between 1 and 10000.

printui-error-invalid-range = Range must be a number between 1 and { $numPages }.
printui-error-invalid-start-overflow = The “from” page number must be smaller than the “to” page number.
