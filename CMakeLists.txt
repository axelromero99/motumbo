cmake_minimum_required(VERSION 3.22)
project(tumbo LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_subdirectory(vendor/box3d EXCLUDE_FROM_ALL)

add_executable(sim sim/tumbo.c)
target_link_libraries(sim PRIVATE box3d::box3d)

if(EMSCRIPTEN)
	target_compile_options(sim PRIVATE -msimd128 -msse2)
	set_target_properties(sim PROPERTIES OUTPUT_NAME "tumbo" SUFFIX ".js")
	target_link_options(sim PRIVATE
		"-sMODULARIZE=1"
		"-sEXPORT_ES6=1"
		"-sEXPORT_NAME=createTumbo"
		"-sENVIRONMENT=web,node"
		"-sALLOW_MEMORY_GROWTH=1"
		"-sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU32,HEAPU8"
		"-sINITIAL_MEMORY=33554432"
		"--no-entry"
	)
endif()
