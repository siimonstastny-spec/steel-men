// Steel Men – registers every procedural robot part (side-effect imports) and re-exports the kit entry points.
import './RobotLegs.js';
import './RobotTorsos.js';
import './RobotArms.js';

export {
  ProcRobot, createProcRobot, ProcRobotPart, createProcRobotPart, robotPartIds, resolveRobotCombo, robotKit, ROBOT_KIT,
} from './RobotKit.js';
