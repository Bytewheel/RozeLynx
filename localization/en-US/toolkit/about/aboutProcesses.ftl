
about-processes-title = Process Manager

about-processes-column-action =
    .title = Actions


about-processes-shutdown-process =
    .title = Unload tabs and kill process
about-processes-kill-process =
    .title = Kill process
about-processes-shutdown-tab =
    .title = Close tab

about-processes-profile-process =
    .title = { $duration ->
   [one] Profile all threads of this process for { $duration } second
  *[other] Profile all threads of this process for { $duration } seconds
}


about-processes-column-name = Name
about-processes-column-memory-resident = Memory
about-processes-column-cpu-total = CPU


about-processes-browser-process = { -brand-short-name } ({ $pid })
about-processes-web-process = Shared Web Process ({ $pid })
about-processes-file-process = Files ({ $pid })
about-processes-extension-process = Extensions ({ $pid })
about-processes-privilegedabout-process = About pages ({ $pid })
about-processes-plugin-process = Plugins ({ $pid })
about-processes-privilegedmozilla-process = { -vendor-short-name } sites ({ $pid })
about-processes-gmp-plugin-process = Gecko Media Plugins ({ $pid })
about-processes-gpu-process = GPU ({ $pid })
about-processes-vr-process = VR ({ $pid })
about-processes-rdd-process = Data Decoder ({ $pid })
about-processes-socket-process = Network ({ $pid })
about-processes-fork-server-process = Fork Server ({ $pid })
about-processes-preallocated-process = Preallocated ({ $pid })
about-processes-utility-process = Utility ({ $pid })
about-processes-inference-process = Inference ({ $pid })

about-processes-unknown-process = Other: { $type } ({ $pid })


about-processes-web-isolated-property-private = private
about-processes-web-isolated-property-serviceworker = serviceworker
about-processes-web-isolated-property-jit-disabled = JIT disabled
about-processes-web-isolated-property-with-coop-coep = cross-origin isolated


about-processes-web-isolated-process2 = { $origin } ({ $properties })


about-processes-active-threads = { $active ->
   [one] { $active } active thread out of { $number }: { $list }
  *[other] { $active } active threads out of { $number }: { $list }
}

about-processes-inactive-threads = { $number ->
   [one] { $number } inactive thread
  *[other] { $number } inactive threads
}

about-processes-thread-name-and-id = { $name }
    .title = Thread id: { $tid }

about-processes-tab-name = Tab: { $name }
about-processes-preloaded-tab = Preloaded New Tab

about-processes-frame-name-one = Subframe: { $url }

about-processes-frame-name-many = Subframes ({ $number }): { $shortUrl }


about-processes-utility-actor-unknown = Unknown actor
about-processes-utility-actor-audio-decoder-generic = Generic Audio Decoder
about-processes-utility-actor-audio-decoder-applemedia = Apple Media Audio Decoder
about-processes-utility-actor-audio-decoder-wmf = Windows Media Framework Audio Decoder
about-processes-utility-actor-mf-media-engine = Windows Media Foundation Media Engine CDM
about-processes-utility-actor-js-oracle = JavaScript Oracle
about-processes-utility-actor-windows-utils = Windows Utils
about-processes-utility-actor-windows-file-dialog = Windows File Dialog
about-processes-utility-actor-pkcs11-module = Security Module Helper
about-processes-utility-actor-hw-inference = Hardware Accelerated Inference


about-processes-cpu = { NUMBER($percent, maximumSignificantDigits: 2, style: "percent") }
    .title = Total CPU time: { NUMBER($total, maximumFractionDigits: 0) }{ $unit }

about-processes-cpu-user-and-kernel-not-ready = (measuring)

about-processes-cpu-almost-idle = < 0.1%
    .title = Total CPU time: { NUMBER($total, maximumFractionDigits: 0) }{ $unit }

about-processes-cpu-fully-idle = idle
    .title = Total CPU time: { NUMBER($total, maximumFractionDigits: 0) }{ $unit }


about-processes-total-memory-size-changed = { NUMBER($total, maximumFractionDigits:0) }{ $totalUnit }
   .title = Evolution: { $deltaSign }{ NUMBER($delta, maximumFractionDigits:0) }{ $deltaUnit }

about-processes-total-memory-size-no-change = { NUMBER($total, maximumFractionDigits:0) }{ $totalUnit }


duration-unit-ns = ns
duration-unit-us = µs
duration-unit-ms = ms
duration-unit-s = s
duration-unit-m = m
duration-unit-h = h
duration-unit-d = d


memory-unit-B = B
memory-unit-KB = KB
memory-unit-MB = MB
memory-unit-GB = GB
memory-unit-TB = TB
memory-unit-PB = PB
memory-unit-EB = EB
