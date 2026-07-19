"""Author the rig-agnostic Cove table-room card-player pose set.

Run with Blender 5.1:
  blender --background --python scripts/blender-author-cove-card-poses.py -- \
    <clyt-armscrossed.glb> <hermes-armscrossed.glb> <output-dir> <preview-dir>

The imported Meshy chair-sit clip is sampled at 0.20 seconds for the seated
hips/legs. Arm, torso, and head rotations are then authored in a normalized
human frame (X left/right, -Y forward, Z up). Every exported action contains
two identical keyed frames, so it has non-zero duration while remaining a
true frozen pose. Non-hips translations are zeroed to mirror the runtime
Meshy `hips-only` retarget policy.
"""

from array import array
import math
import os
import sys

import bpy
from mathutils import Euler, Quaternion, Vector


POSES = {
    "cove_peek": {
        "lean": 8.0,
        "head_pitch": 20.0,
        "head_roll": 0.0,
        "left_arm_blend": 0.48,
        "right_arm_blend": 0.48,
    },
    "cove_think": {
        "lean": 10.0,
        "head_pitch": 8.0,
        "head_roll": -6.0,
        "left_arm_blend": 0.06,
        "right_arm_blend": 0.68,
    },
    "cove_watch": {
        "lean": 25.0,
        "head_pitch": -17.0,
        "head_roll": 0.0,
        "left_arm_blend": 0.0,
        "right_arm_blend": 0.0,
    },
    "cove_rest": {
        "lean": 2.0,
        "head_pitch": 0.0,
        "head_roll": 0.0,
        "left_arm_blend": 0.0,
        "right_arm_blend": 0.0,
    },
}

DEFORM_BONES = (
    "Hips", "Spine", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
)


def user_args():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 4:
        raise SystemExit(
            "usage: blender --background --python blender-author-cove-card-poses.py "
            "-- <clyt.glb> <hermes.glb> <output-dir> <preview-dir>"
        )
    return args


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def find_armature():
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"expected one armature, found {[obj.name for obj in armatures]}")
    return armatures[0]


def sample_seated_base(armature, sample_seconds=0.20):
    action = next(iter(bpy.data.actions), None)
    if action is None:
        raise RuntimeError("source GLB has no animation action")
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    sample_frame = action.frame_range[0] + sample_seconds * fps
    bpy.context.scene.frame_set(int(math.floor(sample_frame)))
    bpy.context.scene.frame_subframe = sample_frame - math.floor(sample_frame)
    bpy.context.view_layer.update()
    rotations = {
        bone.name: bone.rotation_quaternion.copy()
        for bone in armature.pose.bones
    }
    hips_location = armature.pose.bones["Hips"].location.copy()
    # Meshy's first keyed phase is the clean bilateral lap hold. Preserve the
    # t≈0.20 seated body/leg base above, but use this earliest held arm-chain
    # sample as the neutral endpoint so no transition asymmetry leaks into a
    # static pose (the native Hermes export exposes that asymmetry most).
    lap_arm_rotations = {
        bone_name: rotation.copy()
        for bone_name, rotation in rotations.items()
    }
    crossed_frame = action.frame_range[0] + 1.20 * fps
    bpy.context.scene.frame_set(int(math.floor(crossed_frame)))
    bpy.context.scene.frame_subframe = crossed_frame - math.floor(crossed_frame)
    bpy.context.view_layer.update()
    crossed_rotations = {
        bone.name: bone.rotation_quaternion.copy()
        for bone in armature.pose.bones
    }
    return rotations, lap_arm_rotations, crossed_rotations, hips_location, action.name, sample_frame


def apply_pose(armature, pose_name, spec, base_rotations, lap_arm_rotations, crossed_rotations, hips_location):
    if armature.animation_data:
        armature.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)

    for bone in armature.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.location = hips_location if bone.name == "Hips" else Vector((0.0, 0.0, 0.0))
        bone.scale = Vector((1.0, 1.0, 1.0))
        bone.rotation_quaternion = base_rotations.get(bone.name, Quaternion())

    spine = armature.pose.bones["Spine"]
    spine.rotation_quaternion = (
        Euler((-math.radians(spec["lean"]), 0.0, 0.0), "XYZ").to_quaternion()
        @ spine.rotation_quaternion
    )
    head = armature.pose.bones["Head"]
    head.rotation_quaternion = (
        Euler((math.radians(spec["head_pitch"]), 0.0, math.radians(spec["head_roll"])), "XYZ").to_quaternion()
        @ head.rotation_quaternion
    )

    for side in ("Left", "Right"):
        blend = spec[f"{side.lower()}_arm_blend"]
        for suffix in ("Shoulder", "Arm", "ForeArm", "Hand"):
            bone_name = f"{side}{suffix}"
            bone = armature.pose.bones.get(bone_name)
            crossed = crossed_rotations.get(bone_name)
            lap = lap_arm_rotations.get(bone_name)
            if bone is not None and crossed is not None and lap is not None:
                bone.rotation_quaternion = lap.slerp(crossed, blend)
    bpy.context.view_layer.update()

    action = bpy.data.actions.new(pose_name)
    armature.animation_data_create()
    armature.animation_data.action = action
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 2
    for frame in (1, 2):
        bpy.context.scene.frame_set(frame)
        for bone_name in DEFORM_BONES:
            bone = armature.pose.bones.get(bone_name)
            if bone is None:
                continue
            bone.keyframe_insert("location", frame=frame, group=bone_name)
            bone.keyframe_insert("rotation_quaternion", frame=frame, group=bone_name)
            bone.keyframe_insert("scale", frame=frame, group=bone_name)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()


def mesh_bounds():
    minimum = Vector((float("inf"),) * 3)
    maximum = Vector((float("-inf"),) * 3)
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            minimum.x = min(minimum.x, point.x)
            minimum.y = min(minimum.y, point.y)
            minimum.z = min(minimum.z, point.z)
            maximum.x = max(maximum.x, point.x)
            maximum.y = max(maximum.y, point.y)
            maximum.z = max(maximum.z, point.z)
    return minimum, maximum


def look_at(camera, target):
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


def combine_images(front_path, three_quarter_path, output_path):
    front = bpy.data.images.load(front_path, check_existing=False)
    three_quarter = bpy.data.images.load(three_quarter_path, check_existing=False)
    width, height = front.size
    front_pixels = array("f", [0.0]) * (width * height * 4)
    quarter_pixels = array("f", [0.0]) * (width * height * 4)
    front.pixels.foreach_get(front_pixels)
    three_quarter.pixels.foreach_get(quarter_pixels)
    combined = bpy.data.images.new("posecheck", width=width * 2, height=height, alpha=True)
    combined_pixels = array("f", [0.0]) * (width * height * 8)
    row_size = width * 4
    combined_row_size = row_size * 2
    for row in range(height):
        src = row * row_size
        dst = row * combined_row_size
        combined_pixels[dst:dst + row_size] = front_pixels[src:src + row_size]
        combined_pixels[dst + row_size:dst + combined_row_size] = quarter_pixels[src:src + row_size]
    combined.pixels.foreach_set(combined_pixels)
    combined.filepath_raw = output_path
    combined.file_format = "PNG"
    combined.save()
    bpy.data.images.remove(front)
    bpy.data.images.remove(three_quarter)
    bpy.data.images.remove(combined)
    os.remove(front_path)
    os.remove(three_quarter_path)


def render_posecheck(output_path):
    minimum, maximum = mesh_bounds()
    center = (minimum + maximum) * 0.5
    extent = max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z)
    distance = max(extent * 2.1, 2.8)

    world = bpy.context.scene.world or bpy.data.worlds.new("PosecheckWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (0.035, 0.045, 0.055, 1.0)
    background.inputs[1].default_value = 0.7

    bpy.ops.object.light_add(type="AREA", location=(distance, -distance, maximum.z + extent))
    key = bpy.context.object
    key.data.energy = 900
    key.data.shape = "DISK"
    key.data.size = extent * 2.0
    bpy.ops.object.light_add(type="AREA", location=(-distance, -distance * 0.4, center.z))
    fill = bpy.context.object
    fill.data.energy = 500
    fill.data.size = extent * 1.5

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.lens = 58
    bpy.context.scene.camera = camera
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    temp_front = output_path + ".front.png"
    temp_quarter = output_path + ".threequarter.png"
    camera.location = (center.x, center.y - distance, center.z + extent * 0.03)
    look_at(camera, center)
    scene.render.filepath = temp_front
    bpy.ops.render.render(write_still=True)
    camera.location = (center.x + distance * 0.72, center.y - distance * 0.72, center.z + extent * 0.06)
    look_at(camera, center)
    scene.render.filepath = temp_quarter
    bpy.ops.render.render(write_still=True)
    combine_images(temp_front, temp_quarter, output_path)


def export_pose(source_path, pose_name, spec, output_path, preview_path, sample_seconds=0.20):
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = find_armature()
    base_rotations, lap_arm_rotations, crossed_rotations, hips_location, source_action, sample_frame = sample_seated_base(
        armature,
        sample_seconds,
    )
    apply_pose(armature, pose_name, spec, base_rotations, lap_arm_rotations, crossed_rotations, hips_location)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_animations=True,
        export_force_sampling=False,
        export_nla_strips=False,
        export_apply=False,
        use_selection=False,
    )
    render_posecheck(preview_path)
    print(
        f"[cardpose] {pose_name}: source_action={source_action} "
        f"sample_frame={sample_frame:.3f} output={output_path} preview={preview_path}"
    )


def main():
    clyt_source, hermes_source, output_dir, preview_dir = user_args()
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(preview_dir, exist_ok=True)
    for pose_name, spec in POSES.items():
        export_pose(
            clyt_source,
            pose_name,
            spec,
            os.path.join(output_dir, f"clyt-{pose_name}.glb"),
            os.path.join(preview_dir, f"posecheck-{pose_name}-clyt.png"),
        )
    export_pose(
        hermes_source,
        "cove_watch",
        POSES["cove_watch"],
        os.path.join(output_dir, "hermes-cove_watch.glb"),
        os.path.join(preview_dir, "posecheck-cove_watch-hermes.png"),
        sample_seconds=0.0,
    )


if __name__ == "__main__":
    main()
