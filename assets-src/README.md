# Source models

Raw downloads that `tools/assets/build.sh` turns into the game-ready files in `public/models/`.
The raw `.glb` files aren't committed (they're large); put them here with these names to rebuild.

| File | Model | Author | License | Source |
| --- | --- | --- | --- | --- |
| `charger.glb` | 1970 Dodge Charger R/T Fast And Furious Edition | [OUTPISTON](https://sketchfab.com/outpiston) | [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/1970-dodge-charger-rt-fast-and-furious-edition-fd195aaa9dad4aefbace532050b7fca6) |
| `skyline.glb` | 2002 Nissan Skyline GTR R34 Fast and Furious | [Ddiaz Design](https://sketchfab.com/ddiaz-design) | [CC BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/2002-nissan-skyline-gtr-r34-fast-and-furious-f863fe03fb4b48a58291935c2f0de7b9) |
| `police.glb` | Police car | [Mateusz Woliński](https://sketchfab.com/jeandiz) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/police-car-9166b13b6ae341f4bfc093edb71d74f4) |
| `christ.glb` | Christ The Redeemer | [naveenhimal799](https://sketchfab.com/naveenhimal799) | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | [Sketchfab](https://sketchfab.com/3d-models/christ-the-redeemer-d6f51d0fad7142a08ed26455f84f72ca) |

Changes made for the game (all four): rigs and helpers removed, parts merged by material, re-oriented
and scaled to metres, compressed (meshopt geometry, WebP textures). The police car was also scaled to
real size and simplified to about 45k triangles, and the Skyline body to about 60% of its triangles.
The modified Charger and Skyline in `public/models/` are shared under the same CC BY-NC-SA 4.0 license:
non-commercial use only, with credit, and derivatives under the same terms.

Note: the internal part names of the two hero cars suggest they may originally come from a commercial
racing game. They're fine for prototyping; replace them with originals before any wider release.

## Rebuilding

```bash
python3 -m venv .bpy && .bpy/bin/pip install bpy==5.2.2   # Blender as a Python module
tools/assets/build.sh
```

# Map data

`osm/` holds the OpenStreetMap data for San Juan, Puerto Rico (Hato Rey and the Teodoro Moscoso
Bridge) that `tools/map/build.mjs` turns into `src/map/sanjuan.json`. The `tile_*.json` downloads
aren't committed (about 35 MB); `npm run map:fetch` gets them again from the OpenStreetMap API, and
the lagoon outline (`lagoon.json`) from Nominatim.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). `src/map/sanjuan.json`
is a derived database and is shared under the same license.
