{
  "targets": [
    {
      "target_name": "check_randomx_vendor",
      "type": "none",
      "actions": [
        {
          "action_name": "check_randomx_vendor",
          "inputs": [],
          "outputs": ["<(module_root_dir)/deps/randomx/CMakeLists.txt"],
          "conditions": [
            ["OS=='win'", {
              "action": [
                "cmd", "/c",
                "if exist <(module_root_dir)\\deps\\randomx\\CMakeLists.txt (exit /b 0) else (echo Missing vendored RandomX source at deps\\randomx & echo Reinstall the package from a complete source archive or git checkout & exit /b 1)"
              ]
            }, {
              "action": [
                "sh", "-c",
                "test -f '<(module_root_dir)/deps/randomx/CMakeLists.txt' || { echo 'Missing vendored RandomX source at deps/randomx'; echo 'Reinstall the package from a complete source archive or git checkout'; exit 1; }"
              ]
            }]
          ]
        }
      ]
    },
    {
      "target_name": "build_randomx",
      "type": "none",
      "dependencies": ["check_randomx_vendor"],
      "actions": [
        {
          "action_name": "build_randomx_lib",
          "inputs": ["<(module_root_dir)/deps/randomx/CMakeLists.txt"],
          "outputs": [
            "<(module_root_dir)/deps/randomx/build/librandomx.a"
          ],
          "conditions": [
            ["OS=='win'", {
              "outputs": ["<(module_root_dir)/deps/randomx/build/Release/randomx.lib"],
              "action": [
                "cmd", "/c",
                "cd <(module_root_dir)/deps/randomx && if exist build rmdir /S /Q build & mkdir build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release -DRANDOMX_HAVE_JIT=ON -DRANDOMX_HAVE_AES=ON && cmake --build . --config Release"
              ]
            }, {
              "action": [
                "sh", "-c",
                "cd '<(module_root_dir)/deps/randomx' && rm -rf build && mkdir -p build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release -DRANDOMX_HAVE_JIT=ON -DRANDOMX_HAVE_AES=ON -DCMAKE_C_FLAGS='-O3 -march=native -mtune=native' -DCMAKE_CXX_FLAGS='-O3 -march=native -mtune=native' && make -j$(nproc 2>/dev/null || echo 4)"
              ]
            }]
          ]
        }
      ]
    },
    {
      "target_name": "randomx",
      "dependencies": ["build_randomx"],
      "sources": [
        "src/randomx.cpp",
        "src/share_verifier.cpp",
        "src/context_manager.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "deps/randomx/src"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")",
        "build_randomx"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "RANDOMX_HAVE_JIT",
        "RANDOMX_HAVE_AES"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-O3",
        "-march=native",
        "-mtune=native",
        "-funroll-loops"
      ],
      "libraries": [
        "<(module_root_dir)/deps/randomx/build/librandomx.a"
      ],
      "conditions": [
        ["OS=='linux'", {
          "cflags_cc": [
            "-mavx2",
            "-maes",
            "-pthread"
          ],
          "link_settings": {
            "libraries": [
              "-lpthread"
            ]
          },
          "defines": [
            "RANDOMX_HAVE_HUGE_PAGES"
          ]
        }],
        ["OS=='win'", {
          "libraries": [
            "<(module_root_dir)/deps/randomx/build/Release/randomx.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/arch:AVX2"]
            }
          }
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "OTHER_CPLUSPLUSFLAGS": [
              "-mavx2",
              "-maes"
            ]
          }
        }]
      ]
    }
  ]
}
