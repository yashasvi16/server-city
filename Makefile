.PHONY: test race run dev build build-single docker city
BLENDER_PY ?= python3
test:            ## backend unit tests
	cd backend && go test ./...
race:            ## backend tests with the race detector
	cd backend && go test -race -count=1 ./...
run: build       ## backend serving the built frontend on :8080
	cd backend && STATIC_DIR=../frontend/dist go run ./cmd/server
dev:             ## frontend dev server (proxies /api and /ws to :8080)
	cd frontend && npm run dev
build:           ## production frontend build -> frontend/dist
	cd frontend && npm ci && npm run build
build-single:    ## one self-contained HTML file -> frontend/dist-single/index.html
	cd frontend && npm run build:single
docker:
	docker compose up --build
city:            ## re-model and re-bake the city in Blender (pip install bpy==5.* pillow); slow on CPU
	cd frontend && npm run export-scene
	cd tools/blender && $(BLENDER_PY) build_city.py bake ../../build/city
	cd frontend && npx gltf-transform meshopt ../build/city/city.glb src/assets/city/city.glb
	cp build/city/*.jpg build/city/*.png frontend/src/assets/city/
