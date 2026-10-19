cmake_minimum_required(VERSION 3.16)

project(ldm_cpp_engine
    VERSION 0.1.0
    DESCRIPTION "Cross-platform download manager C++ engine"
    LANGUAGES CXX
)

find_package(Threads REQUIRED)
find_package(CURL REQUIRED)
include(GNUInstallDirs)
include(CheckCXXSourceCompiles)
check_cxx_source_compiles(
    "#include <fcntl.h>\n#include <unistd.h>\nint main() { int descriptors[2]; return ::pipe2(descriptors, O_CLOEXEC); }"
    LDM_HAVE_PIPE2
)

set(LDM_DESKTOP_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../desktop-ui")
set(LDM_TRANSFER_METRICS_JS "${CMAKE_CURRENT_SOURCE_DIR}/../extension/transfer-metrics.js")
set(LDM_MEDIA_OPTIONS_JS "${CMAKE_CURRENT_SOURCE_DIR}/../extension/media-options.js")
set(LDM_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${LDM_DESKTOP_UI_DIR}/index.html"
    "${LDM_DESKTOP_UI_DIR}/app.css"
    "${LDM_DESKTOP_UI_DIR}/app.js"
    "${LDM_DESKTOP_UI_DIR}/manifest.webmanifest"
    "${LDM_DESKTOP_UI_DIR}/service-worker.js"
    "${LDM_DESKTOP_UI_DIR}/icon.svg"
    "${LDM_TRANSFER_METRICS_JS}"
    "${LDM_MEDIA_OPTIONS_JS}"
)
file(MAKE_DIRECTORY "${LDM_GENERATED_DIR}")
file(READ "${LDM_DESKTOP_UI_DIR}/index.html" LDM_UI_INDEX_HTML)
file(READ "${LDM_DESKTOP_UI_DIR}/app.css" LDM_UI_APP_CSS)
file(READ "${LDM_DESKTOP_UI_DIR}/app.js" LDM_UI_APP_JS)
file(READ "${LDM_TRANSFER_METRICS_JS}" LDM_UI_TRANSFER_METRICS_JS)
file(READ "${LDM_MEDIA_OPTIONS_JS}" LDM_UI_MEDIA_OPTIONS_JS)
file(READ "${LDM_DESKTOP_UI_DIR}/manifest.webmanifest" LDM_UI_MANIFEST)
file(READ "${LDM_DESKTOP_UI_DIR}/service-worker.js" LDM_UI_SERVICE_WORKER)
file(READ "${LDM_DESKTOP_UI_DIR}/icon.svg" LDM_UI_ICON_SVG)
configure_file(desktop_ui_bundle.h.in "${LDM_GENERATED_DIR}/desktop_ui_bundle.h" @ONLY)

add_executable(ldm-downloader
    main.cpp
    downloader.cpp
    download_registry.cpp
    ipc_server.cpp
)

target_compile_features(ldm-downloader PRIVATE cxx_std_20)
target_link_libraries(ldm-downloader PRIVATE Threads::Threads CURL::libcurl)
target_include_directories(ldm-downloader PRIVATE "${LDM_GENERATED_DIR}")
if(LDM_HAVE_PIPE2)
    target_compile_definitions(ldm-downloader PRIVATE LDM_HAVE_PIPE2=1)
endif()

if(APPLE)
    set(LDM_MACOS_ICON "${CMAKE_CURRENT_SOURCE_DIR}/../packaging/macos/LDM.icns")
    target_sources(ldm-downloader PRIVATE "${LDM_MACOS_ICON}")
    set_source_files_properties("${LDM_MACOS_ICON}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
    set(LDM_MACOS_INFO_PLIST "${CMAKE_CURRENT_BINARY_DIR}/LDM-Info.plist")
    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/../packaging/macos/Info.plist.in"
        "${LDM_MACOS_INFO_PLIST}"
        @ONLY
    )
    target_compile_definitions(ldm-downloader PRIVATE LDM_MACOS_APP_BUNDLE=1)
    set_target_properties(ldm-downloader PROPERTIES
        MACOSX_BUNDLE TRUE
        OUTPUT_NAME "LDM"
        MACOSX_BUNDLE_BUNDLE_NAME "LDM Download Manager"
        MACOSX_BUNDLE_GUI_IDENTIFIER "org.ldm.downloadmanager"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_INFO_PLIST "${LDM_MACOS_INFO_PLIST}"
    )
    install(TARGETS ldm-downloader BUNDLE DESTINATION Applications)
else()
    install(TARGETS ldm-downloader RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
    install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../packaging/linux/ldm.desktop"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/applications")
    install(FILES "${LDM_DESKTOP_UI_DIR}/icon.svg"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps"
        RENAME ldm.svg)
endif()

install(FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/../README.md"
    "${CMAKE_CURRENT_SOURCE_DIR}/../LICENSE"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/doc/ldm-download-manager"
)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(ldm-downloader PRIVATE
        -Wall
        -Wextra
        -Wpedantic
        -Wconversion
        -Wshadow
    )
endif()

include(CTest)
option(LDM_REQUIRE_VERIFIED_MEDIA_TLS "Require verified media helpers at runtime and in release checks" ON)
if(LDM_REQUIRE_VERIFIED_MEDIA_TLS)
    target_compile_definitions(ldm-downloader PRIVATE LDM_REQUIRE_VERIFIED_MEDIA_TLS=1)
endif()
if(BUILD_TESTING)
    add_executable(ldm-engine-features-driver tests/engine_features_driver.cpp downloader.cpp)
    if(LDM_REQUIRE_VERIFIED_MEDIA_TLS)
        target_compile_definitions(ldm-engine-features-driver PRIVATE LDM_REQUIRE_VERIFIED_MEDIA_TLS=1)
    endif()
    target_compile_features(ldm-engine-features-driver PRIVATE cxx_std_20)
    target_link_libraries(ldm-engine-features-driver PRIVATE Threads::Threads CURL::libcurl)
    target_include_directories(ldm-engine-features-driver PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    if(LDM_HAVE_PIPE2)
        target_compile_definitions(ldm-engine-features-driver PRIVATE LDM_HAVE_PIPE2=1)
    endif()
    add_executable(ldm-output-reservation-test
        tests/output_reservation_test.cpp
        downloader.cpp
    )
    target_compile_features(ldm-output-reservation-test PRIVATE cxx_std_20)
    target_link_libraries(ldm-output-reservation-test PRIVATE Threads::Threads CURL::libcurl)
    target_include_directories(ldm-output-reservation-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    if(LDM_HAVE_PIPE2)
        target_compile_definitions(ldm-output-reservation-test PRIVATE LDM_HAVE_PIPE2=1)
    endif()
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(ldm-output-reservation-test PRIVATE
            -Wall
            -Wextra
            -Wpedantic
            -Wconversion
            -Wshadow
        )
    endif()
    add_test(NAME output-path-reservation COMMAND ldm-output-reservation-test)

    add_executable(ldm-download-registry-test
        tests/download_registry_test.cpp
        download_registry.cpp
    )
    target_compile_features(ldm-download-registry-test PRIVATE cxx_std_20)
    target_link_libraries(ldm-download-registry-test PRIVATE Threads::Threads)
    target_include_directories(ldm-download-registry-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(ldm-download-registry-test PRIVATE
            -Wall
            -Wextra
            -Wpedantic
            -Wconversion
            -Wshadow
        )
    endif()
    add_test(NAME download-job-registry COMMAND ldm-download-registry-test)

    find_package(Python3 COMPONENTS Interpreter QUIET)
    if(Python3_Interpreter_FOUND)
        add_test(NAME media-quality-and-audio
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/media_features_test.py"
                "$<TARGET_FILE:ldm-engine-features-driver>")
        set_tests_properties(media-quality-and-audio PROPERTIES TIMEOUT 90 SKIP_RETURN_CODE 77)
        add_test(NAME http-pause-resume
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_pause_test.py"
                "$<TARGET_FILE:ldm-engine-features-driver>")
        set_tests_properties(http-pause-resume PROPERTIES TIMEOUT 40)
        add_test(NAME manifest-pause-resume
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/manifest_pause_test.py"
                "$<TARGET_FILE:ldm-engine-features-driver>")
        set_tests_properties(manifest-pause-resume PROPERTIES TIMEOUT 30)
        add_test(NAME public-transfer-controls-and-inspection
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_controls_inspection_test.py"
                "$<TARGET_FILE:ldm-downloader>")
        set_tests_properties(public-transfer-controls-and-inspection PROPERTIES TIMEOUT 60)
        add_test(NAME http-progress-backpressure
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_backpressure_test.py"
                "$<TARGET_FILE:ldm-downloader>")
        set_tests_properties(http-progress-backpressure PROPERTIES TIMEOUT 20)
        add_test(NAME ftp-download
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/ftp_download_test.py"
                "$<TARGET_FILE:ldm-downloader>")
        set_tests_properties(ftp-download PROPERTIES TIMEOUT 30)
        add_test(NAME tls-download-trust
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/tls_download_test.py"
                "$<TARGET_FILE:ldm-downloader>" "$<TARGET_FILE:ldm-engine-features-driver>")
        set_tests_properties(tls-download-trust PROPERTIES TIMEOUT 60 SKIP_RETURN_CODE 77)
        if(LDM_REQUIRE_VERIFIED_MEDIA_TLS)
            set_tests_properties(tls-download-trust PROPERTIES
                ENVIRONMENT "LDM_REQUIRE_VERIFIED_MEDIA_TLS=1")
            add_test(NAME media-tls-runtime-policy
                COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/media_tls_policy_test.py"
                    "$<TARGET_FILE:ldm-engine-features-driver>")
            set_tests_properties(media-tls-runtime-policy PROPERTIES TIMEOUT 15)
        endif()
        add_test(NAME http-download-reconnect
            COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_reconnect_test.py"
                "$<TARGET_FILE:ldm-downloader>"
        )
        set_tests_properties(http-download-reconnect PROPERTIES TIMEOUT 30)
        add_test(NAME http-download-cancel
            COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_cancel_test.py"
                "$<TARGET_FILE:ldm-downloader>"
        )
        set_tests_properties(http-download-cancel PROPERTIES TIMEOUT 30)
        add_test(NAME http-manifest-cancel
            COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_manifest_cancel_test.py"
                "$<TARGET_FILE:ldm-downloader>"
        )
        set_tests_properties(http-manifest-cancel PROPERTIES TIMEOUT 20)
        add_test(NAME http-head-fallback
            COMMAND "${Python3_EXECUTABLE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/http_head_fallback_test.py"
                "$<TARGET_FILE:ldm-downloader>"
        )
        set_tests_properties(http-head-fallback PROPERTIES TIMEOUT 30)
    endif()

    find_program(LDM_NODE_EXECUTABLE NAMES node)
    if(LDM_NODE_EXECUTABLE)
        execute_process(
            COMMAND "${LDM_NODE_EXECUTABLE}" --version
            RESULT_VARIABLE LDM_NODE_RESULT
            OUTPUT_VARIABLE LDM_NODE_VERSION
            OUTPUT_STRIP_TRAILING_WHITESPACE
            ERROR_QUIET
        )
        string(REGEX REPLACE "^v" "" LDM_NODE_VERSION "${LDM_NODE_VERSION}")
        if(LDM_NODE_RESULT EQUAL 0 AND LDM_NODE_VERSION VERSION_GREATER_EQUAL "18.0.0")
            add_test(NAME desktop-and-extension-recovery
                COMMAND "${LDM_NODE_EXECUTABLE}" --test
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/background-flow.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../desktop-ui/tests/recovery.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/transfer-metrics.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/media-detection.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/media-sources.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/content-discovery.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/media-options.test.cjs"
                    "${CMAKE_CURRENT_SOURCE_DIR}/../extension/tests/popup-controls.test.cjs"
            )
            set_tests_properties(desktop-and-extension-recovery PROPERTIES TIMEOUT 30)
        endif()
    endif()
endif()
