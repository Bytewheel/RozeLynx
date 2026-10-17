

download-utils-short-seconds =
    { $timeValue ->
        [one] s
       *[other] s
    }
download-utils-short-minutes =
    { $timeValue ->
        [one] m
       *[other] m
    }
download-utils-short-hours =
    { $timeValue ->
        [one] h
       *[other] h
    }
download-utils-short-days =
    { $timeValue ->
        [one] d
       *[other] d
    }


download-utils-status = { $timeLeft } — { $transfer } ({ $rate } { $unit }/sec)
download-utils-status-infinite-rate = { $timeLeft } — { $transfer } (Really fast)
download-utils-status-no-rate = { $timeLeft } — { $transfer }

download-utils-bytes = bytes
download-utils-kilobyte = KB
download-utils-megabyte = MB
download-utils-gigabyte = GB

download-utils-transfer-same-units = { $progress } of { $total } { $totalUnits }
download-utils-transfer-diff-units = { $progress } { $progressUnits } of { $total } { $totalUnits }
download-utils-transfer-no-total = { $progress } { $progressUnits }

download-utils-time-pair = { $time }{ $unit }
download-utils-time-left-single = { $time } left
download-utils-time-left-double = { $time1 } { $time2 } left
download-utils-time-few-seconds = A few seconds left
download-utils-time-unknown = Unknown time left

download-utils-yesterday = Yesterday
