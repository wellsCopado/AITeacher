# 已审组件

白名单：`content/components.json`。只能引用其中 `status: 已审` 的组件和版本。

| 组件 | 版本 | 知识 | 参数 | 主题皮肤 | 热点锚点 | 动作 |
| --- | --- | --- | --- | --- | --- | --- |
| PerimeterArea | 1.2 | 周长与面积的区别 | a, b（1–10 m 整数）, theme, showUnits | reef, garden | fence, tile, unit, shrimp | walk, fill, focus |
| ArrayMultiplier | 1.0 | 乘法的意义 | rows, cols（1–9）, theme | blocks、robot_factory | row, col, total | reveal, rotate |

ArrayMultiplier 的 `robot_factory`（机器人工厂）：一台真实尺寸的六轴工业机械臂从身后的传送带抓起一整行齿轮，一行一行放到托盘上（reveal），转台把托盘转 90°（rotate），行变成列。相邻两行一行钢、一行黄铜，方便数行。热点 `row` 在第一行左边，`col` 在第一列后面，`total` 在托盘上方。素材写 `M-robot-cell`、`H-warehouse`。主题是机器人、机械臂、工厂时用它，不用积木代替。

需要新的知识点或交互时，不要在 LessonSpec 里变通，向家长说明需要开发新组件（M2 起）。主题皮肤“待开发”的同理，开素材工单。
