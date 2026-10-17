
about-telemetry-ping-data-source = Ping data source:
about-telemetry-show-current-data = Current data
about-telemetry-show-archived-ping-data = Archived ping data
about-telemetry-show-subsession-data = Show subsession data
about-telemetry-choose-ping = Choose ping:
about-telemetry-archive-ping-type = Ping Type
about-telemetry-archive-ping-header = Ping
about-telemetry-option-group-today = Today
about-telemetry-option-group-yesterday = Yesterday
about-telemetry-option-group-older = Older
about-telemetry-previous-ping = <<
about-telemetry-next-ping = >>
about-telemetry-page-title = Telemetry Data
about-telemetry-current-store = Current Store:
about-telemetry-more-information = Looking for more information?
about-telemetry-firefox-data-doc = The <a data-l10n-name="data-doc-link">Firefox Data Documentation</a> contains guides about how to work with our data tools.
about-telemetry-telemetry-client-doc = The <a data-l10n-name="client-doc-link">Firefox Telemetry client documentation</a> includes definitions for concepts, API documentation and data references.
about-telemetry-telemetry-dashboard = The <a data-l10n-name="dashboard-link">Telemetry dashboards</a> allow you to visualize the data Mozilla receives via Telemetry.
about-telemetry-telemetry-probe-dictionary = The <a data-l10n-name="probe-dictionary-link">Probe Dictionary</a> provides details and descriptions for the probes collected by Telemetry.
about-telemetry-show-in-Firefox-json-viewer = Open in the JSON viewer
about-telemetry-home-section = Home
about-telemetry-general-data-section = General Data
about-telemetry-environment-data-section = Environment Data
about-telemetry-session-info-section = Session Information
about-telemetry-scalar-section = Scalars
about-telemetry-keyed-scalar-section = Keyed Scalars
about-telemetry-histograms-section = Histograms
about-telemetry-keyed-histogram-section = Keyed Histograms
about-telemetry-events-section = Events
about-telemetry-simple-measurements-section = Simple Measurements
about-telemetry-slow-sql-section = Slow SQL Statements
about-telemetry-addon-details-section = Add-on Details
about-telemetry-late-writes-section = Late Writes
about-telemetry-raw-payload-section = Raw Payload
about-telemetry-raw = Raw JSON
about-telemetry-full-sql-warning = NOTE: Slow SQL debugging is enabled. Full SQL strings may be displayed below but they will not be submitted to Telemetry.
about-telemetry-fetch-stack-symbols = Fetch function names for stacks
about-telemetry-hide-stack-symbols = Show raw stack data
about-telemetry-data-type =
    { $channel ->
        [release] release data
       *[prerelease] pre-release data
    }
about-telemetry-upload-type =
    { $uploadcase ->
        [enabled] enabled
       *[disabled] disabled
    }
about-telemetry-histogram-stats =
    { $sampleCount ->
        [one] { $sampleCount } sample, average = { $prettyAverage }, sum = { $sum }
       *[other] { $sampleCount } samples, average = { $prettyAverage }, sum = { $sum }
    }
about-telemetry-page-subtitle = This page shows the information about performance, hardware, usage and customizations collected by Telemetry. This information is submitted to { $telemetryServerOwner } to help improve { -brand-full-name }.
about-telemetry-settings-explanation = Telemetry is collecting { about-telemetry-data-type } and upload is <a data-l10n-name="upload-link">{ about-telemetry-upload-type }</a>.
about-telemetry-ping-details = Each piece of information is sent bundled into “<a data-l10n-name="ping-link">pings</a>”. You are looking at the { $name }, { $timestamp } ping.
about-telemetry-data-details-current = Each piece of information is sent bundled into “<a data-l10n-name="ping-link">pings</a>“. You are looking at the current data.
about-telemetry-filter-placeholder =
    .placeholder = Find in { $selectedTitle }
about-telemetry-filter-all-placeholder =
    .placeholder = Find in all sections
about-telemetry-results-for-search = Results for “{ $searchTerms }”
about-telemetry-no-search-results = Sorry! There are no results in { $sectionName } for “{ $currentSearchText }”
about-telemetry-no-search-results-all = Sorry! There are no results in any sections for “{ $searchTerms }”
about-telemetry-no-data-to-display = Sorry! There is currently no data available in “{ $sectionName }”
about-telemetry-current-data-sidebar = current data
about-telemetry-telemetry-ping-type-all = all
about-telemetry-histogram-copy = Copy
about-telemetry-slow-sql-main = Slow SQL Statements on Main Thread
about-telemetry-slow-sql-other = Slow SQL Statements on Helper Threads
about-telemetry-slow-sql-hits = Hits
about-telemetry-slow-sql-average = Avg. Time (ms)
about-telemetry-slow-sql-statement = Statement
about-telemetry-addon-table-id = Add-on ID
about-telemetry-addon-table-details = Details
about-telemetry-addon-provider = { $addonProvider } Provider
about-telemetry-keys-header = Property
about-telemetry-names-header = Name
about-telemetry-values-header = Value
about-telemetry-late-writes-title = Late Write #{ $lateWriteCount }
about-telemetry-stack-title = Stack:
about-telemetry-memory-map-title = Memory map:
about-telemetry-error-fetching-symbols = An error occurred while fetching symbols. Check that you are connected to the Internet and try again.
about-telemetry-time-stamp-header = timestamp
about-telemetry-category-header = category
about-telemetry-method-header = method
about-telemetry-object-header = object
about-telemetry-extra-header = extra
about-telemetry-process = { $process } process
