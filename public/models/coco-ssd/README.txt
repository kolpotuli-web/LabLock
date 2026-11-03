OFFLINE MODEL ASSET REQUIREMENT
The COCO-SSD lite_mobilenet_v2 model.json and its five group1-shardNof5 weight files must be vendored into this directory. They are intentionally not replaced with placeholder files: placeholder weights would make inference fail. The app requests /models/coco-ssd/model.json.
