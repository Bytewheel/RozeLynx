
about-sync-log-title = Sync logs
about-sync-log-page-header =
    .heading = Sync logs
    .description = Diagnostic logs written by sync.


about-sync-log-filter-type =
    .aria-label = Type
about-sync-log-filter-type-all =
    .label = All
about-sync-log-filter-type-success =
    .label = Success
about-sync-log-filter-type-error =
    .label = Error

about-sync-log-filter-date =
    .aria-label = Date
about-sync-log-filter-date-all =
    .label = All time
about-sync-log-filter-date-today =
    .label = Today
about-sync-log-filter-date-7days =
    .label = Last 7 days
about-sync-log-filter-date-30days =
    .label = Last 30 days

about-sync-log-search-input =
    .placeholder = Search logs
    .aria-label = Search logs


about-sync-log-refresh-button =
    .label = Refresh
about-sync-log-download-button =
    .label = Download visible logs (.zip)
about-sync-log-clear-button =
    .label = Clear logs


about-sync-log-count =
    { $count ->
        [one] { $count } log
       *[other] { $count } logs
    }

about-sync-log-row-success =
    .heading = Success — { DATETIME($date, dateStyle: "medium", timeStyle: "medium") }

about-sync-log-row-error =
    .heading = Error — { DATETIME($date, dateStyle: "medium", timeStyle: "medium") }

about-sync-log-row-size = { $value } { $unit }

about-sync-log-empty = No sync logs have been recorded.
about-sync-log-empty-filtered = No logs match the current filters.


about-sync-log-view-error = Could not read this log file.

about-sync-log-open-raw =
    .label = Open raw


about-sync-log-clear-confirm-title = Clear sync logs?
about-sync-log-clear-confirm-message =
    { $count ->
        [one] This will permanently delete { $count } visible log file.
       *[other] This will permanently delete { $count } visible log files.
    }
about-sync-log-clear-confirm-accept = Delete
